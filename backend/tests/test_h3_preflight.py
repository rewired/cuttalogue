"""Dependency-free checks for the MiniMax H3 generation preflight."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.h3_preflight import inspect_generation  # noqa: E402


def codes(report: dict, level: str) -> set[str]:
    return {issue["code"] for issue in report[level]}


project = {
    "assets": [
        {"id": "lead", "type": "image"},
        {"id": "clip", "type": "video"},
        *[{"id": f"image-{index}", "type": "image"} for index in range(10)],
    ],
}
shot = {"startSeconds": 0.0, "endSeconds": 6.0}
valid_body = {
    "prompt": " ".join(f"word{index}" for index in range(360)),
    "referenceAssetIds": ["lead"],
}

valid = inspect_generation(project, shot, valid_body)
assert valid["ok"]
assert valid["mode"] == "reference_to_video"
assert valid["errors"] == []
assert valid["warnings"] == []
assert valid["frameCount"] >= 6 * 24
print("ok - valid reference generation passes preflight")

bad_references = inspect_generation(project, shot, {
    **valid_body,
    "referenceAssetIds": ["lead", "lead", "clip", "missing"],
})
assert not bad_references["ok"]
assert {"references_duplicate", "reference_type_invalid", "reference_missing"} <= codes(bad_references, "errors")
print("ok - duplicate, non-image, and missing references are rejected")

too_many = inspect_generation(project, shot, {
    **valid_body,
    "referenceAssetIds": [f"image-{index}" for index in range(10)],
})
assert "too_many_image_references" in codes(too_many, "errors")
print("ok - H3's nine-image reference cap is enforced")

unsupported_extend = inspect_generation(project, shot, {
    **valid_body,
    "extendAssetId": "clip",
})
assert "extend_unsupported" in codes(unsupported_extend, "errors")
print("ok - inert Extend configuration is rejected before generation")

long_prompt = inspect_generation(project, shot, {
    **valid_body,
    "prompt": "x" * 7001,
})
assert "prompt_too_long" in codes(long_prompt, "errors")
print("ok - H3 prompt character limit is enforced")

warning_report = inspect_generation(project, {"startSeconds": 0, "endSeconds": 1}, {
    "prompt": "overall_soundscape:\nN/A",
    "referenceAssetIds": [],
})
assert warning_report["ok"]
assert {
    "prompt_word_count",
    "silent_soundscape_with_vocal_reference",
    "duration_outside_trained_range",
} <= codes(warning_report, "warnings")
print("ok - non-blocking prompt, audio, and trained-range guidance is reported")

print("\nAll H3 preflight checks passed.")
