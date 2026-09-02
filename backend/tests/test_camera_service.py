"""Regression coverage for backend parity with the browser camera contract."""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.camera_service import compile_path, compile_shot, evaluate_path, validate_shot  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


def vector_close(actual, expected, epsilon=1e-9):
    return len(actual) == len(expected) and all(abs(value - expected[index]) <= epsilon for index, value in enumerate(actual))


push = compile_path([{"startSeconds": 0, "endSeconds": 2, "movement": "push_in", "speed": "linear"}], 2)
check(vector_close(evaluate_path(push, 1)["position"], [0, 1.6, 3.5]), "push-in interpolation matches the browser contract")
check(vector_close(evaluate_path(push, 2)["position"], [0, 1.6, 3]), "final path endpoint is evaluated")

sequence = compile_path([
    {"startSeconds": 0, "endSeconds": 1, "movement": "push_in", "speed": "linear"},
    {"startSeconds": 1, "endSeconds": 2, "movement": "truck", "direction": "right", "speed": "linear"},
], 2)
check(evaluate_path(sequence, 1)["segmentIndex"] == 1, "a shared boundary belongs to the new segment")
check(vector_close(evaluate_path(sequence, 2)["position"], [1, 1.6, 3]), "sequential segments inherit the previous endpoint")

pan = compile_path([{"startSeconds": 0, "endSeconds": 1, "movement": "pan", "direction": "left", "amplitude": "large", "focalLength": "85mm", "speed": "linear"}], 1)
check(abs(evaluate_path(pan, 1)["yaw"] + math.pi / 4) <= 1e-9, "large pan-left maps to calibrated yaw")
check(evaluate_path(pan, 1)["focalLengthMm"] == 85, "authored focal length is preserved")

zoom_with_lens = compile_path([{"startSeconds": 0, "endSeconds": 1, "movement": "zoom_in", "focalLength": "70mm"}], 1)
check(evaluate_path(zoom_with_lens, 1)["focalLengthMm"] == 70, "authored zoom lens overrides the profile factor")
check(not zoom_with_lens["warnings"], "authored zoom lens does not emit a false unsupported-movement warning")

invalid = compile_path([
    {"startSeconds": 0, "endSeconds": 2, "movement": "truck", "focalLength": "wide"},
    {"startSeconds": 1, "endSeconds": 3, "movement": "tracking_shot"},
], 3)
codes = [warning["code"] for warning in invalid["warnings"]]
check(codes == ["invalid_focal_length", "missing_direction", "overlapping_segments", "missing_target", "missing_direction"], "warning order and codes match the browser contract")

scene = {"id": "scene-1", "unitsPerMeter": 1, "defaultCamera": {"position": [0, 0, 4], "target": [0, 0, 0], "focalLengthMm": 35}, "anchors": {"performer": {"position": [0, 0, 0]}}, "motionProfile": {"smallAngleDegrees": 90}}
shot = {"id": 7, "startSeconds": 10, "endSeconds": 11, "sceneId": "scene-1", "preview": {"interpreterProfile": "cinematic-v1", "initialCameraOverride": None, "targetBindings": {}}, "direction": {"camera": [{"startSeconds": 0, "endSeconds": 1, "movement": "arc_shot", "direction": "right", "amplitude": "small", "target": "performer", "speed": "linear"}]}}
project = {"scenes": [scene]}
compiled = compile_shot(shot, project)
check(validate_shot(shot, project)["valid"], "calibrated target-aware path validates")
check(vector_close(evaluate_path(compiled, 1)["position"], [4, 0, 0], 1e-8), "scene anchors and profiles drive arc evaluation")
check(vector_close(evaluate_path(compiled, 1)["rotationQuaternion"], [0, -math.sqrt(0.5), 0, math.sqrt(0.5)], 1e-8), "camera rotation quaternion matches yaw/pitch/roll")

if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll backend camera service checks passed.")
