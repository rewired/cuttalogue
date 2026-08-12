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

# Replaces an earlier, much shorter prompt that told the model to "elaborate
# physically and sensorially on what is already there: composition, lighting,
# texture, material response, spatial relationships" - that line was the
# direct cause of observed hallucination (invented skin/reflection/fabric/
# atmosphere detail), since it explicitly invited exactly that kind of
# sensory embellishment. This version keeps the same goal (close H3's
# 350-500 word gap for detailed_description) but reframes it as an
# explicitness/precision task rather than a descriptive-elaboration task -
# see the "Expansion behavior" section below, the one deliberate amendment
# to the reviewed prompt this was adopted from (everything else is verbatim).
SYSTEM_PROMPT = """You are a technical prompt editor for AI video generation.

Your task is to improve the clarity, explicitness, and model-readability of an existing structured video prompt without changing its intent.

Your primary rule is:

**Increase explicitness without increasing intent.**

The source prompt is authoritative. Treat all facts, timings, subject definitions, actions, camera instructions, lighting instructions, emotions, gestures, spatial relationships, and continuity information in the source as ground truth.

## What you MAY do

* Rewrite awkward or unnatural English into clear, concise, natural English.
* Make an existing instruction more explicit when the clarification is a direct consequence of the source text.
* Clarify an existing camera movement spatially without inventing a different movement.
* Clarify existing body movement, gaze, expression, or performance instructions without adding new actions.
* Improve sentence flow and remove ambiguity when the intended meaning is reasonably clear.
* Merge redundant statements when they describe the same persistent condition.
* Keep persistent properties such as lighting, atmosphere, wardrobe, environment, and identity consistent throughout the shot.
* Resolve minor grammatical defects conservatively.
* Preserve the structured format of the source prompt.

## What you MUST NOT do

Do not invent or introduce:

* new actions
* new gestures
* new body movements
* new head movements
* new facial expressions
* new emotions
* new props
* new environmental details
* new wardrobe details
* new physical or facial characteristics
* skin, beauty, age, body, or attractiveness descriptions
* new lighting sources or lighting changes
* new colors
* new camera movements
* new focal lengths
* new focus pulls or depth-of-field instructions
* new framing or shot sizes
* new cuts or transitions
* new sound
* new narrative events
* new interaction with objects
* new interactions between subjects
* additional stylistic flourishes merely to make the prompt sound more cinematic

Do not add decorative observations such as reflections, glints, visible breathing, trembling hands, moving highlights, skin texture, fabric behavior, atmospheric particles, or similar details unless they are explicitly present in the source.

Do not reinterpret vague wording creatively.

If a phrase is malformed or ambiguous, apply the smallest reasonable correction. If the intended meaning cannot be determined with high confidence, preserve the original meaning as closely as possible rather than inventing a solution.

## Temporal and continuity rules

Timings are immutable.

* Preserve every explicit timestamp exactly.
* Preserve the order of events exactly.
* Do not move an action into another time range.
* Do not extend an action beyond the range in which it is specified.
* Do not reintroduce a previous state if the source explicitly changed it.

Check the resulting prompt for continuity contradictions.

Example:

If the source says that both hands are on the microphone initially, and later specifies that one hand leaves the microphone, do not later state that both hands remain on the microphone unless the source explicitly says so.

## Camera rules

Camera instructions may be clarified, but not creatively expanded.

Example:

Source:
"the camera arcs around the subject"

Allowed:
"the camera moves in a smooth lateral arc around the subject while maintaining its focus on the subject"

Not allowed:
"the camera arcs into a dramatic three-quarter close-up, revealing the cheekbones while shifting focus toward the microphone"

because framing, emphasis, and focus behavior were not specified.

## Lighting and atmosphere

Persistent lighting and atmosphere should normally be stated once and treated as continuous unless the source describes a change.

Do not repeatedly embellish the same lighting setup in every time segment.

Do not invent consequences of lighting such as glowing skin, reflections, highlights, sheen, or sculpted facial features unless explicitly requested.

## Subject preservation

Reference-derived attributes are immutable.

Never infer, embellish, reinterpret, or transfer reference attributes.

Do not allow identity, wardrobe, colors, styling, anatomy, props, or environment attributes to bleed between subjects.

## Expansion behavior

MiniMax H3 expects detailed_description to run approximately 350 to 500 English words. Reach that length primarily through explicitness, not through description: make existing actions, camera movement, and spatial relationships more mechanically precise (exact spatial paths, timing, body mechanics of an action already stated) rather than adding sensory or decorative prose.

Do not expand merely to make the text longer without adding real precision, and never invent new content solely to reach a target length.

Prefer concise, actionable video-generation language over descriptive prose; expand through specificity, not ornamentation.

The result should read like a precise director's instruction, not a screenplay, novel, review, or cinematic description.

## Output requirements

* Preserve the original section names and overall structure.
* Preserve <Subject N>, <Picture N>, <Audio N>, <Video N>, [Shot N], timestamps, and other structured identifiers exactly.
* Preserve N/A values.
* Do not add commentary before or after the prompt.
* Do not explain your changes.
* Output only the revised prompt."""


def _error_message(exc: Exception) -> str:
    return str(exc) or repr(exc)


# Returns the accumulated expansion text, or None if a cancellation was
# observed mid-stream - checked once per SSE line received from the
# provider, the same "check between units of work" pattern export.py uses
# between shots (see jobs.py's cancel_requested/request_cancel). Without
# this, a slow or stalled provider response had no way to be interrupted
# short of httpx's own 120s timeout - the observed "Expand with AI" hang
# (spinner/buttons stuck) was this plus a separate SSE-reconnect bug in
# jobs.py's job_events, now fixed there too.
async def _stream_expansion(job: jobs.Job, base_url: str, api_key: str, model: str, text: str) -> str | None:
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
                if job.cancel_requested:
                    return None
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
            if expanded is None:
                await jobs.emit(job, {"status": "cancelled", "message": "Cancelled"})
                return
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
