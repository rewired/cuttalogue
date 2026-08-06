# The deferred "LLM-based compiler variant" from docs/h3-shot-direction-
# roadmap.md, scoped tight: expand a deterministically-compiled
# detailed_description (see h3Compiler.js's compileH3Sections) into the
# ~350-500 English words MiniMax H3's own guide expects, without inventing
# any subject, action, camera movement, prop, or dialogue beyond what's
# already stated. Mirrors describe.py's job/SSE streaming shape closely -
# same provider settings, same delta-per-event pattern - but is stateless
# (no project/asset lookup: the frontend already has the compiled text in
# memory) since there's no image to load off disk.
import asyncio
import json
import logging
import traceback

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from . import jobs, settings

logger = logging.getLogger("cuttalogue.expand")

router = APIRouter()

SYSTEM_PROMPT = (
    "You expand a terse, factual shot description into MiniMax H3's expected "
    "detailed_description prose (350 to 500 English words). Do not invent new "
    "subjects, actions, camera movements, props, or dialogue beyond what is "
    "already stated in the input. Preserve every <Subject N> label and every "
    "stated time exactly as given. Elaborate physically and sensorially on "
    "what is already there: composition, lighting, texture, material "
    "response, spatial relationships. Keep the final limits/constraints "
    "sentence(s) at the end verbatim. Output only the expanded "
    "detailed_description text, nothing else - no headers, no explanations, "
    "no markdown."
)


def _error_message(exc: Exception) -> str:
    return str(exc) or repr(exc)


async def _stream_expansion(job: jobs.Job, base_url: str, api_key: str, model: str, text: str) -> str:
    import httpx

    url = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "stream": True,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
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


@router.post("/api/expand-description")
async def expand_description(body: dict = Body(default={})):
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="no text given")

    provider = settings.load_settings()["providers"]["ai"]
    base_url, api_key = provider["baseUrl"], provider["apiKey"]
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="AI provider not configured - set it up on the Setup page first")

    model = (body.get("model") or provider["defaultModel"] or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="no model configured or given")

    job = jobs.create_job()

    async def run():
        try:
            await jobs.emit(job, {"status": "running", "phase": "starting", "message": "Sending request"})
            expanded = await _stream_expansion(job, base_url, api_key, model, text)
            job.result = {"text": expanded}
            await jobs.emit(job, {"status": "done", "phase": "complete", "message": "Done", "result": job.result})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            logger.error("expand-description failed: %s", traceback.format_exc())
            job.error = _error_message(exc)
            await jobs.emit(job, {"status": "error", "message": job.error})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id})
