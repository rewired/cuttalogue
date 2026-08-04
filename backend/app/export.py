# Phase 4a: lip-sync export for a single shot, proving the -ss/-t math
# against H3 render duration (not cut duration) and the ffmpeg-progress job
# shape on one shot before Phase 4b runs it in a per-shot batch loop.
import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from . import frames, jobs, media
from .projects import project_dir

router = APIRouter()

LIP_SYNC_SAMPLE_RATE = "32000"
LIP_SYNC_CHANNELS = "1"


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return data, directory


@router.post("/api/projects/{project_id}/shots/{shot_id}/export/lip-sync")
async def export_lip_sync(project_id: str, shot_id: int):
    data, directory = _load_project(project_id)

    shot = next((s for s in data.get("shots", []) if s["id"] == shot_id), None)
    if shot is None:
        raise HTTPException(status_code=404, detail="shot not found")

    vocal = (data.get("audio") or {}).get("vocal") or {}
    vocal_rel = vocal.get("relativePath")
    if not vocal_rel:
        raise HTTPException(status_code=400, detail="no vocal track uploaded for this project yet")
    vocal_path = directory / vocal_rel
    if not vocal_path.exists():
        raise HTTPException(status_code=400, detail="vocal track file is missing on disk")

    cut_duration = shot["endSeconds"] - shot["startSeconds"]
    calc = frames.frame_calc(cut_duration, data["video"])
    render_duration = calc["renderFrames"] / frames.fps(data["video"])

    scratch_dir = directory / "exports" / "scratch"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    output_path = scratch_dir / f"shot-{shot_id}-lip_sync.flac"
    output_relative_path = f"exports/scratch/{output_path.name}"

    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{shot['startSeconds']:.6f}",
        "-i",
        str(vocal_path),
        "-t",
        f"{render_duration:.6f}",
        "-ar",
        LIP_SYNC_SAMPLE_RATE,
        "-ac",
        LIP_SYNC_CHANNELS,
        "-c:a",
        "flac",
        str(output_path),
    ]

    job = jobs.create_job()

    async def run():
        try:
            await jobs.emit(
                job,
                {
                    "status": "running",
                    "phase": "encoding",
                    "message": "Encoding lip_sync.flac",
                    "progressFraction": 0.0,
                },
            )

            async def on_progress(fraction: float) -> None:
                await jobs.emit(job, {"status": "running", "phase": "encoding", "progressFraction": fraction})

            await media.run_ffmpeg_with_progress(cmd, render_duration, on_progress)

            job.result = {
                "relativePath": output_relative_path,
                "renderDurationSeconds": render_duration,
                "cutFrames": calc["cutFrames"],
                "renderFrames": calc["renderFrames"],
                "overhangFrames": calc["overhangFrames"],
            }
            await jobs.emit(
                job,
                {"status": "done", "phase": "complete", "message": "Saved", "progressFraction": 1.0, "result": job.result},
            )
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            job.error = str(exc)
            await jobs.emit(job, {"status": "error", "message": str(exc)})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id, "expectedDurationSeconds": render_duration})
