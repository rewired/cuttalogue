"""Transport-neutral, path-confined read access to CUTTAlogue projects."""
import hashlib
import json
import re
from pathlib import Path

PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


class ProjectNotFoundError(LookupError):
    pass


class InvalidProjectError(ValueError):
    pass


class ProjectRepository:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _file(self, project_id: str) -> Path:
        if not isinstance(project_id, str) or not PROJECT_ID_PATTERN.fullmatch(project_id):
            raise InvalidProjectError("invalid project id")
        candidate = (self.root / project_id / "project.json").resolve()
        if self.root not in candidate.parents:
            raise InvalidProjectError("project path escapes repository")
        return candidate

    def read(self, project_id: str) -> dict:
        file = self._file(project_id)
        if not file.exists():
            raise ProjectNotFoundError("project not found")
        try:
            raw = file.read_bytes()
            project = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise InvalidProjectError("project file is invalid") from error
        if not isinstance(project, dict):
            raise InvalidProjectError("project root must be an object")
        return {
            "id": project_id,
            "revision": hashlib.sha256(raw).hexdigest(),
            "updatedAt": file.stat().st_mtime,
            "project": project,
        }

    def list(self) -> list[dict]:
        if not self.root.exists():
            return []
        projects = []
        for entry in self.root.iterdir():
            if not entry.is_dir() or not PROJECT_ID_PATTERN.fullmatch(entry.name):
                continue
            try:
                record = self.read(entry.name)
            except (ProjectNotFoundError, InvalidProjectError):
                continue
            data = record["project"]
            projects.append({
                "id": record["id"],
                "name": data.get("name") or "",
                "shotCount": len(data.get("shots") or []),
                "updatedAt": record["updatedAt"],
                "revision": record["revision"],
            })
        return sorted(projects, key=lambda item: item["updatedAt"], reverse=True)
