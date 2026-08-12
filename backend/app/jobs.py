# Minimal in-memory job registry with SSE progress events. Deliberately the
# simplest possible async job (writing a JSON file) so the pattern is proven
# here and just reused, not redesigned, when Phase 4/5 wrap FFmpeg export and
# AI description calls in the same shape.
import asyncio
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

router = APIRouter()


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error | cancelled
    result: Any = None
    error: str | None = None
    cancel_requested: bool = False
    queue: "asyncio.Queue[dict | None]" = field(default_factory=asyncio.Queue)


_jobs: dict[str, Job] = {}


def create_job() -> Job:
    job = Job(id=uuid.uuid4().hex[:12])
    _jobs[job.id] = job
    return job


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def request_cancel(job: Job) -> None:
    job.cancel_requested = True


class JobCancelled(Exception):
    pass


async def emit(job: Job, event: dict) -> None:
    job.status = event.get("status", job.status)
    await job.queue.put(event)


async def close(job: Job) -> None:
    await job.queue.put(None)  # sentinel: closes the SSE stream


async def run_save_job(job: Job, path: Path, payload: dict) -> None:
    try:
        await emit(job, {"status": "running", "phase": "writing", "message": f"Writing {path.name}"})
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        # A successful real save supersedes any draft.draft.json sitting
        # next to it - once project.json itself reflects this state, there's
        # nothing left for the draft-recovery mechanism to recover.
        draft_path = path.parent / "project.draft.json"
        if draft_path.exists():
            draft_path.unlink()
        job.result = {"path": str(path)}
        await emit(job, {"status": "done", "phase": "complete", "message": "Saved"})
    except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
        job.error = str(exc)
        await emit(job, {"status": "error", "message": str(exc)})
    finally:
        await close(job)


@router.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {"id": job.id, "status": job.status, "result": job.result, "error": job.error}


@router.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    request_cancel(job)
    return {"id": job.id, "cancelRequested": True}


@router.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    async def stream():
        # A client (re)connecting after the job already reached a terminal
        # state - e.g. the browser's EventSource auto-reconnecting after a
        # dropped connection - would otherwise block forever on queue.get():
        # the sentinel that ends the queue was already consumed by whichever
        # connection was open when the job actually finished, so a fresh
        # connection's queue is empty and nothing will ever be put into it
        # again. Synthesize the terminal event straight from the job's own
        # fields instead of relying on a queue that no longer has any
        # history to replay - this is what turned an observed "Expand with
        # AI" hang (spinner/buttons stuck forever) into a real bug fix
        # rather than just a client-side cancel button papering over it.
        if job.status in ("done", "error", "cancelled"):
            event: dict = {"status": job.status}
            if job.status == "done":
                event["result"] = job.result
            elif job.status == "error":
                event["message"] = job.error
            yield f"data: {json.dumps(event)}\n\n"
            return
        while True:
            event = await job.queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
