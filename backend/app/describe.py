# Phase 5: "[Describe image]" - one explicit, user-triggered call per image to
# the configured AI provider (OpenRouter-compatible chat completions API),
# streamed back through the same job/SSE shape export.py already established,
# with each streamed token surfaced as an event's "delta" field so the
# frontend can pour it straight into the editable description field as it
# arrives instead of waiting for the whole response.
import asyncio
import base64
import json
import logging
import mimetypes
import traceback
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from . import jobs, settings
from .projects import project_dir

logger = logging.getLogger("cuttalogue.describe")

router = APIRouter()

PROMPT = (
    "Describe this image concisely but specifically, for use as a visual "
    "reference in a video production shot-planning tool."
)


def _error_message(exc: Exception) -> str:
    return str(exc) or repr(exc)


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return data, directory


async def _stream_description(job: jobs.Job, base_url: str, api_key: str, model: str, image_data_uri: str) -> str:
    import httpx

    url = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "stream": True,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": image_data_uri}},
                ],
            }
        ],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    chunks: list[str] = []
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            if response.status_code != 200:
                body = await response.aread()
                raise RuntimeError(f"provider returned HTTP {response.status_code}: {body.decode(errors='ignore')[:500]}")
            async for line in response.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    break
                try:
                    parsed = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = parsed.get("choices") or []
                delta = (choices[0].get("delta") or {}).get("content") if choices else None
                if delta:
                    chunks.append(delta)
                    await jobs.emit(job, {"status": "running", "phase": "streaming", "delta": delta})

    return "".join(chunks)


@router.post("/api/projects/{project_id}/assets/{asset_id}/describe")
async def describe_asset(project_id: str, asset_id: str, body: dict = Body(default={})):
    data, directory = _load_project(project_id)

    asset = next((a for a in data.get("assets", []) if a["id"] == asset_id), None)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    if asset.get("type") != "image":
        raise HTTPException(status_code=400, detail="only images can be described")

    provider = settings.load_settings()["aiProvider"]
    base_url, api_key = provider["baseUrl"], provider["apiKey"]
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="AI provider not configured - set it up on the Setup page first")

    model = (body.get("model") or provider["defaultModel"] or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="no model configured or given")

    image_path = directory / asset["relativePath"]
    if not image_path.exists():
        raise HTTPException(status_code=400, detail="asset file missing on disk")

    mime = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    image_data_uri = f"data:{mime};base64,{base64.b64encode(image_path.read_bytes()).decode()}"

    job = jobs.create_job()

    async def run():
        try:
            await jobs.emit(job, {"status": "running", "phase": "starting", "message": "Sending request"})
            text = await _stream_description(job, base_url, api_key, model, image_data_uri)
            job.result = {"description": text}
            await jobs.emit(job, {"status": "done", "phase": "complete", "message": "Done", "result": job.result})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            logger.error("describe failed for asset %s: %s", asset_id, traceback.format_exc())
            job.error = _error_message(exc)
            await jobs.emit(job, {"status": "error", "message": job.error})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id})
