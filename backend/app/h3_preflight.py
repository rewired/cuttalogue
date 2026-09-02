"""Pure MiniMax H3 generation checks shared by HTTP and MCP entry points."""
import math
import re
from typing import Any

from . import frames

MAX_PROMPT_CHARS = 7000
MAX_IMAGE_REFERENCES = 9
TRAINED_MIN_FRAMES = 124
TRAINED_MAX_FRAMES = 362
GUIDE_MIN_WORDS = 350
GUIDE_MAX_WORDS = 500


def _issue(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def inspect_generation(project: dict, shot: dict, body: dict) -> dict[str, Any]:
    """Return a deterministic report without touching files or remote services."""
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    prompt = body.get("prompt")
    prompt_text = prompt.strip() if isinstance(prompt, str) else ""
    if not prompt_text:
        errors.append(_issue("prompt_missing", "shot prompt must be compiled or authored before generation"))
    elif len(prompt_text) > MAX_PROMPT_CHARS:
        errors.append(_issue("prompt_too_long", f"shot prompt exceeds the H3 {MAX_PROMPT_CHARS}-character limit"))
    else:
        word_count = len(re.findall(r"\b[\w'-]+\b", prompt_text))
        if word_count < GUIDE_MIN_WORDS or word_count > GUIDE_MAX_WORDS:
            warnings.append(_issue(
                "prompt_word_count",
                f"H3 guidance recommends {GUIDE_MIN_WORDS}-{GUIDE_MAX_WORDS} words; this prompt has {word_count}",
            ))
        if re.search(r"overall_soundscape\s*:\s*(?:\n\s*)?N/A\b", prompt_text, re.IGNORECASE):
            warnings.append(_issue(
                "silent_soundscape_with_vocal_reference",
                "overall_soundscape is N/A even though generation supplies a vocal audio reference",
            ))

    start = shot.get("startSeconds")
    end = shot.get("endSeconds")
    valid_times = all(
        isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        for value in (start, end)
    )
    duration = (end - start) if valid_times else 0
    if not valid_times or start < 0 or duration <= 0:
        errors.append(_issue("shot_time_invalid", "shot must have finite times and end after start"))
        frame_count = frames.H3_MIN_FRAMES
    else:
        frame_count = frames.h3_frame_count(duration)
        if frame_count < TRAINED_MIN_FRAMES or frame_count > TRAINED_MAX_FRAMES:
            warnings.append(_issue(
                "duration_outside_trained_range",
                f"render length {frame_count} frames is outside H3's documented trained range of "
                f"{TRAINED_MIN_FRAMES}-{TRAINED_MAX_FRAMES} frames",
            ))

    reference_ids = body.get("referenceAssetIds") or []
    if not isinstance(reference_ids, list) or not all(isinstance(asset_id, str) for asset_id in reference_ids):
        errors.append(_issue("references_invalid", "referenceAssetIds must be a list of asset ids"))
        reference_ids = []
    if len(reference_ids) != len(set(reference_ids)):
        errors.append(_issue("references_duplicate", "reference images must not contain duplicate assets"))
    if len(reference_ids) > MAX_IMAGE_REFERENCES:
        errors.append(_issue(
            "too_many_image_references",
            f"H3 supports at most {MAX_IMAGE_REFERENCES} image references; received {len(reference_ids)}",
        ))

    assets = {asset.get("id"): asset for asset in (project.get("assets") or []) if isinstance(asset, dict)}
    for asset_id in reference_ids:
        asset = assets.get(asset_id)
        if asset is None:
            errors.append(_issue("reference_missing", f"reference asset {asset_id!r} does not exist"))
        elif asset.get("type") != "image":
            errors.append(_issue("reference_type_invalid", f"reference asset {asset_id!r} is not an image"))

    if body.get("extendAssetId"):
        errors.append(_issue(
            "extend_unsupported",
            "Extend is not supported by the configured R2V_H3_V1 workflow; remove the Extend assignment before generation",
        ))

    return {
        "ok": not errors,
        "mode": "reference_to_video",
        "errors": errors,
        "warnings": warnings,
        "promptCharacters": len(prompt_text),
        "referenceImageCount": len(reference_ids),
        "frameCount": frame_count,
        "renderDurationSeconds": frame_count / frames.H3_FPS,
    }


def error_message(report: dict[str, Any]) -> str:
    return "; ".join(issue["message"] for issue in report.get("errors", []))
