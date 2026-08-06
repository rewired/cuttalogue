# Per-shot video generation against a ComfyUI instance running on a RunPod
# Pod (Serverless is deferred - see comfy_workflow_template.py and
# settings.py for the seams left for it). Same job/SSE shape as describe.py/
# expand.py, but submit-then-poll instead of one long streamed request -
# generation can run for minutes, and short repeated /history polls avoid
# holding one httpx connection open that long. The backend never writes
# project.json (same convention as describe.py/assets.py) - it returns a
# descriptor and the frontend merges it into state as a new take, persisted
# through the normal Save path like everything else.
import asyncio
import json
import logging
import random
import traceback
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from . import jobs, settings
from .comfy_workflow_template import build_workflow_payload
from .projects import project_dir

logger = logging.getLogger("cuttalogue.comfy")

router = APIRouter()

POLL_INTERVAL_SECONDS = 3
POLL_TIMEOUT_SECONDS = 600  # 10 minutes - generous, generation can be slow


def _error_message(exc: Exception) -> str:
    return str(exc) or repr(exc)


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return data, directory


async def _upload_reference_image(client, base_url: str, image_path: Path) -> str:
    # Uploads one image onto ComfyUI's own filesystem, returns the filename
    # ComfyUI assigned it - what a LoadImage node references by name.
    with image_path.open("rb") as fh:
        files = {"image": (image_path.name, fh, "application/octet-stream")}
        res = await client.post(f"{base_url}/upload/image", files=files)
    if res.status_code != 200:
        raise RuntimeError(f"ComfyUI /upload/image returned HTTP {res.status_code}: {res.text[:300]}")
    body = res.json()
    return body.get("name") or image_path.name


async def _upload_reference_video(client, base_url: str, video_path: Path) -> str:
    # VHS' Load Video (Upload) node uploads through the same /upload/image
    # endpoint as images - ComfyUI's upload route just drops the file into
    # its input folder regardless of media type.
    with video_path.open("rb") as fh:
        files = {"image": (video_path.name, fh, "application/octet-stream")}
        res = await client.post(f"{base_url}/upload/image", files=files)
    if res.status_code != 200:
        raise RuntimeError(f"ComfyUI /upload/image returned HTTP {res.status_code}: {res.text[:300]}")
    body = res.json()
    return body.get("name") or video_path.name


async def _submit_and_poll(job: jobs.Job, base_url: str, workflow: dict) -> str:
    # Submits the built workflow graph, polls /history until it has an
    # output, returns the output video's ComfyUI-side filename.
    import httpx

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(f"{base_url}/prompt", json={"prompt": workflow})
        if res.status_code != 200:
            raise RuntimeError(f"ComfyUI /prompt returned HTTP {res.status_code}: {res.text[:300]}")
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI /prompt response had no prompt_id: {res.text[:300]}")

        await jobs.emit(job, {"status": "running", "phase": "queued", "message": "Queued on ComfyUI"})

        elapsed = 0
        while elapsed < POLL_TIMEOUT_SECONDS:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            elapsed += POLL_INTERVAL_SECONDS
            hist_res = await client.get(f"{base_url}/history/{prompt_id}")
            if hist_res.status_code != 200:
                continue  # transient - keep polling until POLL_TIMEOUT_SECONDS
            history = hist_res.json().get(prompt_id)
            if not history:
                await jobs.emit(job, {"status": "running", "phase": "generating", "message": f"Generating ({elapsed}s)"})
                continue

            status = history.get("status") or {}
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI reported an error: {json.dumps(status)[:500]}")

            outputs = history.get("outputs") or {}
            for node_output in outputs.values():
                for video in (node_output.get("videos") or node_output.get("gifs") or []):
                    filename = video.get("filename")
                    if filename:
                        return filename

            await jobs.emit(job, {"status": "running", "phase": "generating", "message": f"Generating ({elapsed}s)"})

    raise RuntimeError(f"Timed out after {POLL_TIMEOUT_SECONDS}s waiting for ComfyUI to finish")


@router.post("/api/projects/{project_id}/shots/{shot_id}/generate")
async def generate_take(project_id: str, shot_id: int, body: dict = Body(default={})):
    import httpx

    data, directory = _load_project(project_id)

    prompt_text = (body.get("prompt") or "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="no prompt given")
    requested_seed = body.get("seed")
    reference_asset_ids = body.get("referenceAssetIds") or []
    extend_asset_id = body.get("extendAssetId")
    extend_start_frame = body.get("extendStartFrame") or 0
    extend_frame_count = body.get("extendFrameCount")

    comfy = settings.load_settings()["providers"]["comfy"]
    base_url = (comfy["baseUrl"] or "").rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="ComfyUI provider not configured - set it up on the Setup page first")

    assets_by_id = {a["id"]: a for a in data.get("assets", [])}
    reference_paths = []
    for asset_id in reference_asset_ids:
        asset = assets_by_id.get(asset_id)
        if not asset:
            continue
        path = directory / asset["relativePath"]
        if path.exists():
            reference_paths.append(path)

    extend_path = None
    if extend_asset_id:
        extend_asset = assets_by_id.get(extend_asset_id)
        if extend_asset:
            candidate = directory / extend_asset["relativePath"]
            if candidate.exists():
                extend_path = candidate

    # A blank/absent seed means "surprise me" - resolved once here so the
    # same concrete value goes into both the submitted workflow and the
    # take record the frontend ends up saving (see h3Compiler-adjacent
    # convention: never let the recorded fact diverge from what was
    # actually submitted).
    resolved_seed = requested_seed if isinstance(requested_seed, int) else random.randint(0, 2**32 - 1)

    take_id = uuid.uuid4().hex[:8]
    job = jobs.create_job()

    async def run():
        try:
            await jobs.emit(job, {"status": "running", "phase": "uploading", "message": "Uploading reference images"})
            async with httpx.AsyncClient(timeout=60) as client:
                uploaded = [await _upload_reference_image(client, base_url, p) for p in reference_paths]
                extend_filename = await _upload_reference_video(client, base_url, extend_path) if extend_path else None

            workflow = build_workflow_payload(
                prompt_text,
                uploaded,
                resolved_seed,
                extend_filename=extend_filename,
                extend_start_frame=extend_start_frame,
                extend_frame_count=extend_frame_count,
            )

            filename = await _submit_and_poll(job, base_url, workflow)

            await jobs.emit(job, {"status": "running", "phase": "downloading", "message": "Downloading result"})
            async with httpx.AsyncClient(timeout=120) as client:
                view_res = await client.get(f"{base_url}/view", params={"filename": filename, "type": "output"})
            if view_res.status_code != 200:
                raise RuntimeError(f"ComfyUI /view returned HTTP {view_res.status_code}")

            take_dir = directory / "shots" / str(shot_id) / "takes" / take_id
            take_dir.mkdir(parents=True, exist_ok=True)
            output_path = take_dir / "output.mp4"
            output_path.write_bytes(view_res.content)

            job.result = {
                "takeId": take_id,
                "relativePath": f"shots/{shot_id}/takes/{take_id}/output.mp4",
                "seed": resolved_seed,
            }
            await jobs.emit(job, {"status": "done", "phase": "complete", "message": "Done", "result": job.result})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            logger.error("generate failed for shot %s: %s", shot_id, traceback.format_exc())
            job.error = _error_message(exc)
            await jobs.emit(job, {"status": "error", "message": job.error})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id, "takeId": take_id})
