"""Transport-neutral port of CUTTAlogue's deterministic camera interpreter."""
import math
import re
from copy import deepcopy
from typing import Any


DEFAULT_CAMERA = {
    "position": [0.0, 1.6, 4.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0,
    "focalLengthMm": 35.0,
}
DEFAULT_PROFILE = {
    "defaultDistanceMeters": 1.0, "smallDistanceMeters": 0.5,
    "largeDistanceMeters": 2.0, "defaultAngleDegrees": 20.0,
    "smallAngleDegrees": 10.0, "largeAngleDegrees": 45.0,
    "zoomInFactor": 0.7, "zoomOutFactor": 1.4,
}
FOCAL_LENGTH = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*$", re.IGNORECASE)


class CameraEvaluationError(ValueError):
    pass


def _number(value: Any, fallback: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _vector(value: Any, fallback: list[float]) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        return list(fallback)
    result = [_number(item, math.nan) for item in value]
    return result if all(math.isfinite(item) for item in result) else list(fallback)


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _camera(source: dict | None = None) -> dict:
    source = source or {}
    return {
        "position": _vector(source.get("position"), DEFAULT_CAMERA["position"]),
        "yaw": _number(source.get("yaw"), DEFAULT_CAMERA["yaw"]),
        "pitch": _number(source.get("pitch"), DEFAULT_CAMERA["pitch"]),
        "roll": _number(source.get("roll"), DEFAULT_CAMERA["roll"]),
        "focalLengthMm": max(1.0, _number(source.get("focalLengthMm"), DEFAULT_CAMERA["focalLengthMm"])),
    }


def _basis(camera: dict) -> dict:
    yaw, pitch, roll = camera["yaw"], camera["pitch"], camera.get("roll", 0.0)
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    right = [cy, 0.0, sy]
    up = [-sy * sp, cp, cy * sp]
    return {
        "forward": [sy * cp, sp, -cy * cp],
        "right": [right[index] * cr + up[index] * sr for index in range(3)],
        "up": [up[index] * cr - right[index] * sr for index in range(3)],
    }


def _add(position: list[float], axis: list[float], distance: float) -> list[float]:
    return [value + axis[index] * distance for index, value in enumerate(position)]


def _look_at(camera: dict, target: list[float]) -> None:
    delta = [target[index] - camera["position"][index] for index in range(3)]
    camera["yaw"] = math.atan2(delta[0], -delta[2])
    camera["pitch"] = math.atan2(delta[1], math.hypot(delta[0], delta[2]))


def _profile(source: dict | None = None) -> dict:
    merged = {**DEFAULT_PROFILE, **(source or {})}
    return {key: max(0.0001, _number(merged.get(key), fallback)) for key, fallback in DEFAULT_PROFILE.items()}


def _amplitude(value: Any, profile: dict, kind: str) -> float:
    suffix = "AngleDegrees" if kind == "angle" else "DistanceMeters"
    prefix = "small" if value == "small" else "large" if value == "large" else "default"
    return profile[prefix + suffix]


def _direction(value: Any, positive: str, negative: str, warnings: list, index: int) -> int:
    if value == positive:
        return 1
    if value == negative:
        return -1
    warnings.append({"code": "unsupported_direction", "segmentIndex": index, "value": value} if value else {"code": "missing_direction", "segmentIndex": index})
    return 1


def _target(segment: dict, targets: dict, default_target: Any, pose: dict, warnings: list, index: int) -> list[float]:
    name = str(segment.get("target") or "").strip()
    candidate = targets.get(name) if name else default_target
    raw = candidate.get("position") if isinstance(candidate, dict) else candidate
    resolved = _vector(raw, []) if isinstance(raw, list) else []
    if len(resolved) == 3:
        return resolved
    warnings.append({"code": "unresolved_target" if name else "missing_target", "segmentIndex": index, "value": name or None})
    return _add(pose["position"], _basis(pose)["forward"], 3.0)


def _focal_length(value: Any, warnings: list, index: int) -> float | None:
    if value is None or value == "":
        return None
    match = FOCAL_LENGTH.match(str(value))
    if not match or float(match.group(1)) <= 0:
        warnings.append({"code": "invalid_focal_length", "segmentIndex": index, "value": value})
        return None
    return float(match.group(1))


def _end_pose(start: dict, segment: dict, profile: dict, targets: dict, default_target: Any, warnings: list, index: int) -> dict:
    end = deepcopy(start)
    movement = segment.get("movement") or "static_shot"
    basis = _basis(start)
    distance = _amplitude(segment.get("amplitude"), profile, "distance")
    angle = math.radians(_amplitude(segment.get("amplitude"), profile, "angle"))
    focal = _focal_length(segment.get("focalLength"), warnings, index)
    if focal is not None:
        end["focalLengthMm"] = focal
    if movement == "static_shot":
        pass
    elif movement == "push_in":
        end["position"] = _add(start["position"], basis["forward"], distance)
    elif movement == "pull_out":
        end["position"] = _add(start["position"], basis["forward"], -distance)
    elif movement == "truck":
        end["position"] = _add(start["position"], basis["right"], distance * _direction(segment.get("direction"), "right", "left", warnings, index))
    elif movement in ("pedestal_up", "pedestal_down"):
        end["position"] = _add(start["position"], [0.0, 1.0, 0.0], distance if movement == "pedestal_up" else -distance)
    elif movement == "pan":
        end["yaw"] += angle * _direction(segment.get("direction"), "right", "left", warnings, index)
    elif movement in ("tilt_up", "tilt_down"):
        end["pitch"] = _clamp(start["pitch"] + (angle if movement == "tilt_up" else -angle), -math.pi / 2, math.pi / 2)
    elif movement in ("roll_cw", "roll_ccw"):
        end["roll"] += -angle if movement == "roll_cw" else angle
    elif movement == "zoom_in":
        if focal is None:
            end["focalLengthMm"] = start["focalLengthMm"] / profile["zoomInFactor"]
    elif movement == "zoom_out":
        if focal is None:
            end["focalLengthMm"] = start["focalLengthMm"] / profile["zoomOutFactor"]
    elif movement == "tracking_shot":
        target = _target(segment, targets, default_target, start, warnings, index)
        axis, sign = basis["right"], 1
        direction = segment.get("direction")
        if direction == "left": sign = -1
        elif direction == "forward": axis = basis["forward"]
        elif direction == "backward": axis, sign = basis["forward"], -1
        elif direction == "up": axis = [0.0, 1.0, 0.0]
        elif direction == "down": axis, sign = [0.0, 1.0, 0.0], -1
        elif direction != "right": _direction(direction, "right", "left", warnings, index)
        end["position"] = _add(start["position"], axis, distance * sign)
        _look_at(end, target)
    elif movement == "arc_shot":
        target = _target(segment, targets, default_target, start, warnings, index)
        sign = _direction(segment.get("direction"), "right", "left", warnings, index)
        relative = [start["position"][item] - target[item] for item in range(3)]
        cosine, sine = math.cos(angle * sign), math.sin(angle * sign)
        end["position"] = [target[0] + relative[0] * cosine + relative[2] * sine, start["position"][1], target[2] - relative[0] * sine + relative[2] * cosine]
        _look_at(end, target)
    else:
        warnings.append({"code": "movement_not_implemented", "segmentIndex": index, "value": movement})
    return end


def compile_path(camera_segments: Any, duration_seconds: float, initial_camera: dict | None = None, profile: dict | None = None, targets: dict | None = None, default_target: Any = None) -> dict:
    duration = max(0.0, _number(duration_seconds, math.inf))
    warnings, segments = [], []
    enabled = [({**item, "sourceIndex": index}) for index, item in enumerate(camera_segments if isinstance(camera_segments, list) else []) if isinstance(item, dict) and item.get("enabled") is not False]
    enabled.sort(key=lambda item: _number(item.get("startSeconds"), 0.0))
    initial = _camera(initial_camera)
    current, previous_end = deepcopy(initial), 0.0
    normalized_profile = _profile(profile)
    for segment in enabled:
        index = segment["sourceIndex"]
        start = _clamp(_number(segment.get("startSeconds"), 0.0), 0.0, duration)
        end = _clamp(_number(segment.get("endSeconds"), start), 0.0, duration)
        if not end > start:
            warnings.append({"code": "invalid_time_range", "segmentIndex": index})
            continue
        if start < previous_end:
            warnings.append({"code": "overlapping_segments", "segmentIndex": index})
        final = _end_pose(current, segment, normalized_profile, targets or {}, default_target, warnings, index)
        segments.append({"sourceIndex": index, "startSeconds": start, "endSeconds": end, "speed": segment.get("speed") or "", "movement": segment.get("movement") or "static_shot", "startPose": deepcopy(current), "endPose": deepcopy(final)})
        current, previous_end = deepcopy(final), max(previous_end, end)
    return {"version": 1, "initialPose": initial, "durationSeconds": duration, "segments": segments, "warnings": warnings}


def _easing(amount: float, speed: Any) -> float:
    value = _clamp(amount, 0.0, 1.0)
    normalized = str(speed or "").strip().lower()
    if normalized in ("linear", "constant"): return value
    if normalized == "fast": return 1 - (1 - value) ** 2
    if normalized == "slow": return value ** 2
    return value * value * (3 - 2 * value)


def _interpolate(start: dict, end: dict, amount: float) -> dict:
    lerp = lambda a, b: a + (b - a) * amount
    return {"position": [lerp(value, end["position"][index]) for index, value in enumerate(start["position"])], "yaw": lerp(start["yaw"], end["yaw"]), "pitch": lerp(start["pitch"], end["pitch"]), "roll": lerp(start["roll"], end["roll"]), "focalLengthMm": lerp(start["focalLengthMm"], end["focalLengthMm"])}


def _result(pose: dict, segment_index: int | None, warnings: list) -> dict:
    yaw, pitch, roll = pose["yaw"], pose["pitch"], pose["roll"]
    cy, sy, cp, sp, cr, sr = math.cos(yaw / 2), math.sin(yaw / 2), math.cos(pitch / 2), math.sin(pitch / 2), math.cos(roll / 2), math.sin(roll / 2)
    return {**deepcopy(pose), "rotationQuaternion": [-cy * sp * cr + sy * cp * sr, sy * cp * cr + cy * sp * sr, sy * sp * cr + cy * cp * sr, cy * cp * cr - sy * sp * sr], "segmentIndex": segment_index, "warnings": deepcopy(warnings)}


def evaluate_path(plan: dict, time_seconds: float) -> dict:
    if not isinstance(plan, dict) or not isinstance(plan.get("segments"), list):
        raise TypeError("A compiled camera path is required.")
    time = _clamp(_number(time_seconds, 0.0), 0.0, plan["durationSeconds"])
    held = plan["initialPose"]
    for index, segment in enumerate(plan["segments"]):
        if time < segment["startSeconds"]:
            return _result(held, None, plan["warnings"])
        endpoint = index == len(plan["segments"]) - 1 and time == segment["endSeconds"]
        if time < segment["endSeconds"] or endpoint:
            raw = (time - segment["startSeconds"]) / (segment["endSeconds"] - segment["startSeconds"])
            return _result(_interpolate(segment["startPose"], segment["endPose"], _easing(raw, segment["speed"])), segment["sourceIndex"], plan["warnings"])
        held = segment["endPose"]
    return _result(held, None, plan["warnings"])


def compile_shot(shot: dict, project: dict) -> dict:
    start, end = _number(shot.get("startSeconds"), math.nan), _number(shot.get("endSeconds"), math.nan)
    if not math.isfinite(start) or not math.isfinite(end):
        raise CameraEvaluationError("a shot with finite timing is required")
    scene = next((item for item in project.get("scenes", []) if isinstance(item, dict) and item.get("id") == shot.get("sceneId")), None)
    preview = shot.get("preview") or {}
    override = preview.get("initialCameraOverride")
    source_camera = override if override is not None else ((scene or {}).get("defaultCamera") or {})
    if not isinstance(source_camera, dict):
        source_camera = {}
    position = _vector(source_camera.get("position"), DEFAULT_CAMERA["position"])
    target = _vector(source_camera.get("target"), [0.0, 1.5, 0.0])
    delta = [target[index] - position[index] for index in range(3)]
    initial = {"position": position, "yaw": _number(source_camera.get("yaw"), math.atan2(delta[0], -delta[2])), "pitch": _number(source_camera.get("pitch"), math.atan2(delta[1], math.hypot(delta[0], delta[2]))), "roll": _number(source_camera.get("roll"), 0.0), "focalLengthMm": _number(source_camera.get("focalLengthMm"), 35.0)}
    anchors, targets = ((scene or {}).get("anchors") or {}), {}
    for name, anchor in anchors.items():
        if isinstance(anchor, dict) and isinstance(anchor.get("position"), list): targets[name] = anchor["position"]
    for name, anchor_name in (preview.get("targetBindings") or {}).items():
        if anchor_name in targets: targets[name] = targets[anchor_name]
    motion = {**DEFAULT_PROFILE, **((scene or {}).get("motionProfile") or {})}
    scale = max(0.0001, _number((scene or {}).get("unitsPerMeter"), 1.0))
    for key in ("defaultDistanceMeters", "smallDistanceMeters", "largeDistanceMeters"):
        motion[key] = (_number(motion.get(key), DEFAULT_PROFILE[key]) or DEFAULT_PROFILE[key]) * scale
    plan = compile_path(((shot.get("direction") or {}).get("camera") or []), max(0.0, end - start), initial, motion, targets, ((scene or {}).get("defaultCamera") or {}).get("target"))
    if shot.get("sceneId") and scene is None: plan["warnings"].append({"code": "unresolved_scene", "value": shot["sceneId"]})
    profile_name = preview.get("interpreterProfile") or "cinematic-v1"
    if profile_name != "cinematic-v1": plan["warnings"].append({"code": "unsupported_interpreter_profile", "value": profile_name})
    return plan


def validate_shot(shot: dict, project: dict) -> dict:
    plan = compile_shot(shot, project)
    return {"valid": not plan["warnings"], "warnings": plan["warnings"], "plan": plan}
