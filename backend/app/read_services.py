"""Read-only application services shared by HTTP and future MCP adapters."""
from copy import deepcopy

from .camera_service import compile_shot, evaluate_path, validate_shot
from .prompt_service import compile_shot_prompt
from .project_repository import ProjectRepository


class EntityNotFoundError(LookupError):
    pass


class ProjectReadService:
    def __init__(self, repository: ProjectRepository):
        self.repository = repository

    def list_projects(self) -> list[dict]:
        return self.repository.list()

    def get_project(self, project_id: str) -> dict:
        return self.repository.read(project_id)

    def _shot(self, project_id: str, shot_id: int) -> tuple[dict, dict]:
        record = self.repository.read(project_id)
        shot = next((item for item in record["project"].get("shots", []) if item.get("id") == shot_id), None)
        if shot is None:
            raise EntityNotFoundError("shot not found")
        return record, shot

    def list_shots(self, project_id: str) -> dict:
        record = self.repository.read(project_id)
        return {"projectId": project_id, "revision": record["revision"], "shots": deepcopy(record["project"].get("shots") or [])}

    def get_shot(self, project_id: str, shot_id: int) -> dict:
        record, shot = self._shot(project_id, shot_id)
        return {"projectId": project_id, "revision": record["revision"], "shot": deepcopy(shot)}

    def get_shot_direction(self, project_id: str, shot_id: int) -> dict:
        record, shot = self._shot(project_id, shot_id)
        direction = shot.get("direction") or {}
        normalized = {
            "camera": direction.get("camera") or [],
            "lighting": direction.get("lighting") or [],
            "subjects": direction.get("subjects") or {},
            "props": direction.get("props") or {},
            "beatNotes": direction.get("beatNotes") or [],
        }
        return {"projectId": project_id, "shotId": shot_id, "revision": record["revision"], "direction": deepcopy(normalized)}

    def get_camera_segments(self, project_id: str, shot_id: int) -> dict:
        result = self.get_shot_direction(project_id, shot_id)
        return {
            "projectId": project_id,
            "shotId": shot_id,
            "revision": result["revision"],
            "cameraSegments": result["direction"]["camera"],
        }

    def validate_camera_path(self, project_id: str, shot_id: int) -> dict:
        record, shot = self._shot(project_id, shot_id)
        result = validate_shot(shot, record["project"])
        return {"projectId": project_id, "shotId": shot_id, "revision": record["revision"], **result}

    def evaluate_camera_path(self, project_id: str, shot_id: int, time_seconds: float) -> dict:
        record, shot = self._shot(project_id, shot_id)
        plan = compile_shot(shot, record["project"])
        return {
            "projectId": project_id, "shotId": shot_id, "revision": record["revision"],
            "timeSeconds": time_seconds, "pose": evaluate_path(plan, time_seconds),
        }

    def compile_shot_prompt(self, project_id: str, shot_id: int) -> dict:
        record, shot = self._shot(project_id, shot_id)
        result = compile_shot_prompt(shot)
        return {"projectId": project_id, "shotId": shot_id, "revision": record["revision"], **result}

    def get_project_warnings(self, project_id: str) -> dict:
        record = self.repository.read(project_id)
        project = record["project"]
        warnings = []
        scenes = {scene.get("id") for scene in project.get("scenes", []) if isinstance(scene, dict)}
        previous_end = None
        seen_ids = set()
        for index, shot in enumerate(project.get("shots") or []):
            shot_id = shot.get("id")
            if shot_id in seen_ids:
                warnings.append({"code": "duplicate_shot_id", "shotId": shot_id})
            seen_ids.add(shot_id)
            start = shot.get("startSeconds")
            end = shot.get("endSeconds")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
                warnings.append({"code": "invalid_shot_timing", "shotId": shot_id})
            elif previous_end is not None and start < previous_end:
                warnings.append({"code": "overlapping_shots", "shotId": shot_id, "index": index})
            if isinstance(end, (int, float)):
                previous_end = max(previous_end or end, end)
            if shot.get("sceneId") and shot["sceneId"] not in scenes:
                warnings.append({"code": "unresolved_scene", "shotId": shot_id, "value": shot["sceneId"]})
        return {"projectId": project_id, "revision": record["revision"], "valid": not warnings, "warnings": warnings}
