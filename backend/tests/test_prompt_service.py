"""Regression coverage for the canonical H3 compiler bridge."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.prompt_service import compile_shot_prompt  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


shot = {
    "id": 1, "startSeconds": 0, "endSeconds": 4, "prompt": "authored prompt stays untouched",
    "assetIds": ["support", "lead"],
    "assetRoles": {"support": "supporting_character", "lead": "primary_character"},
    "constraints": ["No visible text"],
    "direction": {
        "camera": [{"startSeconds": 0, "endSeconds": 4, "movement": "push_in", "speed": "slow"}],
        "lighting": [{"startSeconds": 0, "endSeconds": 4, "exposure": "low_key"}],
        "subjects": {"lead": [{"startSeconds": 0, "endSeconds": 4, "actionType": "sing", "vocalPerformance": "lip_sync"}]},
        "props": {}, "beatNotes": [],
    },
}

first = compile_shot_prompt(shot)
second = compile_shot_prompt(shot)
check(first == second, "identical Direction compiles byte-deterministically")
check(first["compilerVersion"] == "2.1", "result identifies the canonical browser compiler version")
check(first["authoritativeSource"] == "shot.direction", "result identifies Direction as authoritative")
check(first["referenceAssetIds"] == ["lead", "support"], "reference ordering matches the canonical role binding")
check(first["prompt"].index("<Subject 1>") < first["prompt"].index("<Subject 2>"), "subject labels follow canonical ordering")
check("The camera pushes in at slow speed." in first["prompt"], "camera wording comes from the canonical compiler")
check("precise, natural lip sync" in first["prompt"], "character performance wording survives the bridge")
check("The lighting remains low-key." in first["prompt"], "lighting wording survives the bridge")
check("No visible text." in first["prompt"], "authored constraints survive the bridge")
check(shot["prompt"] == "authored prompt stays untouched", "read-only compilation does not overwrite the shot prompt")

if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll canonical prompt service checks passed.")
