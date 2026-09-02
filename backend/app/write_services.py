"""Typed, revision-guarded CUTTAlogue project mutations."""
import math
from copy import deepcopy
from typing import Any

from .project_repository import ProjectRepository, RevisionConflictError


MIN_SHOT_SECONDS = 0.05
MIN_SEGMENT_SECONDS = 0.000001
CAMERA_MOVEMENTS = {
    "zoom_in", "zoom_out", "push_in", "pull_out", "pan", "truck",
    "tilt_up", "tilt_down", "pedestal_up", "pedestal_down", "tracking_shot",
    "arc_shot", "static_shot", "shake_slightly", "shake_strongly", "pov",
    "roll_cw", "roll_ccw",
}
CAMERA_DIRECTIONS = {"", "left", "right", "up", "down", "forward", "backward"}
CAMERA_AMPLITUDES = {"", "small", "large"}
DEPTH_OF_FIELDS = {"", "deep", "medium", "shallow", "very_shallow"}
CAMERA_STRING_FIELDS = {
    "movement", "framing", "speed", "amplitude", "direction", "target",
    "focalLength", "depthOfField", "focusTarget", "transitionToNext",
}
CAMERA_PATCH_FIELDS = CAMERA_STRING_FIELDS | {"startSeconds", "endSeconds", "enabled"}
CAMERA_DEFAULTS = {
    "startSeconds": 0.0, "endSeconds": 0.0, "movement": "zoom_in",
    "framing": "", "speed": "", "amplitude": "", "direction": "",
    "target": "", "focalLength": "", "depthOfField": "", "focusTarget": "",
    "transitionToNext": "", "enabled": True,
}


class WriteValidationError(ValueError):
    pass


class ShotNotFoundError(LookupError):
    pass


class CameraSegmentNotFoundError(LookupError):
    pass


def _finite(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise WriteValidationError(f"{label} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise WriteValidationError(f"{label} must be a finite number") from error
    if not math.isfinite(number):
        raise WriteValidationError(f"{label} must be a finite number")
    return number


def _shots(project: dict) -> list[dict]:
    shots = project.setdefault("shots", [])
    if not isinstance(shots, list) or not all(isinstance(shot, dict) for shot in shots):
        raise WriteValidationError("project shots must be an array of objects")
    shots.sort(key=lambda shot: _finite(shot.get("startSeconds"), "existing shot start"))
    seen_ids = set()
    previous_end = None
    for shot in shots:
        shot_id = shot.get("id")
        if isinstance(shot_id, bool) or not isinstance(shot_id, int) or shot_id in seen_ids:
            raise WriteValidationError("existing shot ids must be unique integers")
        seen_ids.add(shot_id)
        start = _finite(shot.get("startSeconds"), "existing shot start")
        end = _finite(shot.get("endSeconds"), "existing shot end")
        if start < 0 or end - start < MIN_SHOT_SECONDS:
            raise WriteValidationError("existing shot timing is invalid")
        if previous_end is not None and start < previous_end:
            raise WriteValidationError("existing shots overlap")
        previous_end = end
    return shots


def _timing(start_seconds: Any, end_seconds: Any) -> tuple[float, float]:
    start = _finite(start_seconds, "start_seconds")
    end = _finite(end_seconds, "end_seconds")
    if start < 0:
        raise WriteValidationError("shot start must not be negative")
    if end - start < MIN_SHOT_SECONDS:
        raise WriteValidationError(f"shot duration must be at least {MIN_SHOT_SECONDS} seconds")
    return start, end


def _track_duration(project: dict) -> float | None:
    raw = (((project.get("audio") or {}).get("mix") or {}).get("durationSeconds"))
    try:
        duration = float(raw)
    except (TypeError, ValueError):
        return None
    return duration if math.isfinite(duration) and duration > 0 else None


def _ensure_track_bounds(project: dict, end: float) -> None:
    duration = _track_duration(project)
    if duration is not None and end > duration:
        raise WriteValidationError("shot end exceeds track duration")


def _find_shot(shots: list[dict], shot_id: int) -> tuple[int, dict]:
    if isinstance(shot_id, bool) or not isinstance(shot_id, int):
        raise WriteValidationError("shot id must be an integer")
    for index, shot in enumerate(shots):
        if shot.get("id") == shot_id:
            return index, shot
    raise ShotNotFoundError("shot not found")


def _camera_lane(shot: dict) -> list[dict]:
    direction = shot.setdefault("direction", {})
    if not isinstance(direction, dict):
        raise WriteValidationError("shot direction must be an object")
    lane = direction.setdefault("camera", [])
    if not isinstance(lane, list) or not all(isinstance(segment, dict) for segment in lane):
        raise WriteValidationError("camera lane must be an array of objects")
    return lane


def _segment_index(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise WriteValidationError("segment index must be a non-negative integer")
    return value


def _validate_camera_segment(segment: dict, duration: float) -> None:
    start = _finite(segment.get("startSeconds"), "camera segment start")
    end = _finite(segment.get("endSeconds"), "camera segment end")
    if start < 0 or end - start < MIN_SEGMENT_SECONDS or end > duration:
        raise WriteValidationError("camera segment timing must be inside the shot")
    segment["startSeconds"], segment["endSeconds"] = start, end
    for field in CAMERA_STRING_FIELDS:
        if not isinstance(segment.get(field, ""), str):
            raise WriteValidationError(f"camera segment {field} must be a string")
    if segment.get("movement", "") not in CAMERA_MOVEMENTS:
        raise WriteValidationError("unsupported camera movement")
    if segment.get("direction", "") not in CAMERA_DIRECTIONS:
        raise WriteValidationError("unsupported camera direction")
    if segment.get("amplitude", "") not in CAMERA_AMPLITUDES:
        raise WriteValidationError("unsupported camera amplitude")
    if segment.get("depthOfField", "") not in DEPTH_OF_FIELDS:
        raise WriteValidationError("unsupported camera depth of field")
    if not isinstance(segment.get("enabled", True), bool):
        raise WriteValidationError("camera segment enabled must be a boolean")


def _validate_camera_lane(lane: list[dict], duration: float) -> None:
    for segment in lane:
        _validate_camera_segment(segment, duration)
    active = sorted((segment for segment in lane if segment.get("enabled", True)), key=lambda segment: segment["startSeconds"])
    for previous, current in zip(active, active[1:]):
        if current["startSeconds"] < previous["endSeconds"]:
            raise WriteValidationError("active camera segments overlap")


def _response(project_id: str, previous_revision: str, record: dict, shot: dict) -> dict:
    return {
        "projectId": project_id, "previousRevision": previous_revision,
        "revision": record["revision"], "shot": deepcopy(shot),
    }


class ProjectWriteService:
    def __init__(self, repository: ProjectRepository):
        self.repository = repository

    def _read_for_write(self, project_id: str, expected_revision: str) -> dict:
        record = self.repository.read(project_id)
        if record["revision"] != expected_revision:
            raise RevisionConflictError(expected_revision, record["revision"])
        return record

    def create_shot(self, project_id: str, expected_revision: str, start_seconds: float, end_seconds: float, name: str = "") -> dict:
        if not isinstance(name, str):
            raise WriteValidationError("shot name must be a string")
        record = self._read_for_write(project_id, expected_revision)
        project = record["project"]
        shots = _shots(project)
        start, end = _timing(start_seconds, end_seconds)
        _ensure_track_bounds(project, end)
        if any(start < _finite(shot.get("endSeconds"), "existing shot end") and end > _finite(shot.get("startSeconds"), "existing shot start") for shot in shots):
            raise WriteValidationError("shot overlaps an existing shot")
        created = {
            "id": 0, "startSeconds": start, "endSeconds": end, "name": name,
            "prompt": "", "notes": "", "seed": None, "takes": [], "activeTakeId": None,
            "assetIds": [], "assetRoles": {}, "videoRefs": {}, "constraints": [],
            "sceneId": None,
            "preview": {"initialCameraOverride": None, "targetBindings": {}, "interpreterProfile": "cinematic-v1"},
            "direction": {"camera": [], "lighting": [], "subjects": {}, "props": {}, "beatNotes": []},
        }
        shots.append(created)
        shots.sort(key=lambda shot: shot["startSeconds"])
        for index, shot in enumerate(shots):
            shot["id"] = index + 1
        saved = self.repository.write(project_id, project, expected_revision)
        return _response(project_id, expected_revision, saved, created)

    def update_shot_timing(self, project_id: str, shot_id: int, expected_revision: str, start_seconds: float, end_seconds: float) -> dict:
        record = self._read_for_write(project_id, expected_revision)
        project = record["project"]
        shots = _shots(project)
        index, shot = _find_shot(shots, shot_id)
        start, end = _timing(start_seconds, end_seconds)
        _ensure_track_bounds(project, end)
        previous = shots[index - 1] if index > 0 else None
        following = shots[index + 1] if index + 1 < len(shots) else None
        if previous and start < _finite(previous.get("endSeconds"), "previous shot end"):
            raise WriteValidationError("shot overlaps the previous shot")
        if following and end > _finite(following.get("startSeconds"), "next shot start"):
            raise WriteValidationError("shot overlaps the next shot")
        shot["startSeconds"], shot["endSeconds"] = start, end
        saved = self.repository.write(project_id, project, expected_revision)
        return _response(project_id, expected_revision, saved, shot)

    def rename_shot(self, project_id: str, shot_id: int, expected_revision: str, name: str) -> dict:
        if not isinstance(name, str):
            raise WriteValidationError("shot name must be a string")
        record = self._read_for_write(project_id, expected_revision)
        project = record["project"]
        _index, shot = _find_shot(_shots(project), shot_id)
        shot["name"] = name
        saved = self.repository.write(project_id, project, expected_revision)
        return _response(project_id, expected_revision, saved, shot)

    def add_camera_segment(self, project_id: str, shot_id: int, expected_revision: str, segment: dict) -> dict:
        if not isinstance(segment, dict) or set(segment) - CAMERA_PATCH_FIELDS:
            raise WriteValidationError("camera segment contains unsupported fields")
        record = self._read_for_write(project_id, expected_revision)
        project = record["project"]
        _shot_index, shot = _find_shot(_shots(project), shot_id)
        lane = _camera_lane(shot)
        created = {**CAMERA_DEFAULTS, **segment}
        lane.append(created)
        duration = _finite(shot.get("endSeconds"), "shot end") - _finite(shot.get("startSeconds"), "shot start")
        _validate_camera_lane(lane, duration)
        lane.sort(key=lambda item: item["startSeconds"])
        segment_index = next(index for index, item in enumerate(lane) if item is created)
        saved = self.repository.write(project_id, project, expected_revision)
        return {
            "projectId": project_id, "shotId": shot_id, "previousRevision": expected_revision,
            "revision": saved["revision"], "segmentIndex": segment_index, "segment": deepcopy(created),
        }

    def update_camera_segment(self, project_id: str, shot_id: int, segment_index: int, expected_revision: str, patch: dict) -> dict:
        if not isinstance(patch, dict) or not patch or set(patch) - CAMERA_PATCH_FIELDS:
            raise WriteValidationError("camera segment patch is empty or contains unsupported fields")
        record = self._read_for_write(project_id, expected_revision)
        project = record["project"]
        _shot_index, shot = _find_shot(_shots(project), shot_id)
        lane = _camera_lane(shot)
        index = _segment_index(segment_index)
        if index >= len(lane):
            raise CameraSegmentNotFoundError("camera segment not found")
        updated = lane[index]
        updated.update(patch)
        duration = _finite(shot.get("endSeconds"), "shot end") - _finite(shot.get("startSeconds"), "shot start")
        _validate_camera_lane(lane, duration)
        lane.sort(key=lambda item: item["startSeconds"])
        next_index = next(index for index, item in enumerate(lane) if item is updated)
        saved = self.repository.write(project_id, project, expected_revision)
        return {
            "projectId": project_id, "shotId": shot_id, "previousRevision": expected_revision,
            "revision": saved["revision"], "segmentIndex": next_index, "segment": deepcopy(updated),
        }

    def remove_camera_segment(self, project_id: str, shot_id: int, segment_index: int, expected_revision: str) -> dict:
        record = self._read_for_write(project_id, expected_revision)
        project = record["project"]
        _shot_index, shot = _find_shot(_shots(project), shot_id)
        lane = _camera_lane(shot)
        index = _segment_index(segment_index)
        if index >= len(lane):
            raise CameraSegmentNotFoundError("camera segment not found")
        removed = lane.pop(index)
        saved = self.repository.write(project_id, project, expected_revision)
        return {
            "projectId": project_id, "shotId": shot_id, "previousRevision": expected_revision,
            "revision": saved["revision"], "removedSegmentIndex": index,
            "removedSegment": deepcopy(removed),
        }
