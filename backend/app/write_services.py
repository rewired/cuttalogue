"""Typed, revision-guarded CUTTAlogue project mutations."""
import math
from copy import deepcopy
from typing import Any

from .project_repository import ProjectRepository, RevisionConflictError


MIN_SHOT_SECONDS = 0.05


class WriteValidationError(ValueError):
    pass


class ShotNotFoundError(LookupError):
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
