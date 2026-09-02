"""CUTTAlogue MCP server over local STDIO."""
import json
import os
from pathlib import Path
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent, ToolAnnotations

from .camera_service import CameraEvaluationError
from .jobs import JobNotFoundError, read_job_status
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository, RevisionConflictError
from .projects import DATA_DIR
from .prompt_service import PromptCompilationError
from .read_services import EntityNotFoundError, ProjectReadService
from .write_services import ProjectWriteService, ShotNotFoundError, WriteValidationError


EXPECTED_READ_ERRORS = (
    CameraEvaluationError, EntityNotFoundError, InvalidProjectError,
    JobNotFoundError, ProjectNotFoundError, PromptCompilationError,
)
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
CONTROLLED_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)


def _read(operation, *args) -> Any:
    try:
        return operation(*args)
    except EXPECTED_READ_ERRORS as error:
        raise ToolError(str(error)) from error


def _write_error(payload: dict[str, Any]) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(text=json.dumps(payload))],
        structuredContent=payload,
        isError=True,
    )


def _write(operation, *args) -> Any:
    try:
        return operation(*args)
    except RevisionConflictError as error:
        return _write_error({
            "code": "revision_conflict", "message": str(error),
            "expectedRevision": error.expected_revision, "currentRevision": error.current_revision,
        })
    except ProjectNotFoundError as error:
        return _write_error({"code": "project_not_found", "message": str(error)})
    except ShotNotFoundError as error:
        return _write_error({"code": "shot_not_found", "message": str(error)})
    except WriteValidationError as error:
        return _write_error({"code": "validation_error", "message": str(error)})
    except InvalidProjectError as error:
        return _write_error({"code": "invalid_project", "message": str(error)})


def create_mcp_server(data_dir: Path | None = None) -> MCPServer:
    root = data_dir or Path(os.environ.get("CUTTALOGUE_PROJECTS_DIR", DATA_DIR))
    service = ProjectReadService(ProjectRepository(root))
    write_service = ProjectWriteService(ProjectRepository(root))
    server = MCPServer(
        "CUTTAlogue",
        instructions=(
            "Read CUTTAlogue projects, shots, Direction data, camera paths, prompts, and jobs. "
            "Narrow write tools require the exact revision returned by a fresh read."
        ),
    )

    @server.tool(annotations=READ_ONLY)
    def list_projects() -> dict[str, Any]:
        """List CUTTAlogue projects with content revisions and shot counts."""
        return {"projects": _read(service.list_projects)}

    @server.tool(annotations=READ_ONLY)
    def get_project(project_id: str) -> dict[str, Any]:
        """Read one complete CUTTAlogue project by id."""
        return _read(service.get_project, project_id)

    @server.tool(annotations=READ_ONLY)
    def list_shots(project_id: str) -> dict[str, Any]:
        """List all shots in one CUTTAlogue project."""
        return _read(service.list_shots, project_id)

    @server.tool(annotations=READ_ONLY)
    def get_shot(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read one shot by project id and numeric shot id."""
        return _read(service.get_shot, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def get_shot_direction(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read normalized Camera, Lighting, Subject, Prop, and Beat Direction."""
        return _read(service.get_shot_direction, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def get_camera_segments(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read the authoritative shot.direction.camera segments for one shot."""
        return _read(service.get_camera_segments, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def validate_camera_path(project_id: str, shot_id: int) -> dict[str, Any]:
        """Compile and validate a shot's deterministic spatial camera path."""
        return _read(service.validate_camera_path, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def evaluate_camera_path(project_id: str, shot_id: int, time_seconds: float) -> dict[str, Any]:
        """Evaluate a shot-relative deterministic camera pose at a time in seconds."""
        return _read(service.evaluate_camera_path, project_id, shot_id, time_seconds)

    @server.tool(annotations=READ_ONLY)
    def compile_shot_prompt(project_id: str, shot_id: int) -> dict[str, Any]:
        """Compile authored Direction into CUTTAlogue's deterministic H3 prompt without saving it."""
        return _read(service.compile_shot_prompt, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def get_job_status(job_id: str) -> dict[str, Any]:
        """Read one in-memory CUTTAlogue job snapshot without consuming its event stream."""
        return _read(read_job_status, job_id)

    @server.tool(annotations=READ_ONLY)
    def get_project_warnings(project_id: str) -> dict[str, Any]:
        """Validate project timing and scene references without changing data."""
        return _read(service.get_project_warnings, project_id)

    @server.tool(annotations=CONTROLLED_WRITE)
    def create_shot(project_id: str, expected_revision: str, start_seconds: float, end_seconds: float, name: str = "") -> dict[str, Any]:
        """Create one non-overlapping shot when the project revision still matches."""
        return _write(write_service.create_shot, project_id, expected_revision, start_seconds, end_seconds, name)

    @server.tool(annotations=CONTROLLED_WRITE)
    def update_shot_timing(project_id: str, shot_id: int, expected_revision: str, start_seconds: float, end_seconds: float) -> dict[str, Any]:
        """Update one shot's exact bounds when the project revision still matches."""
        return _write(write_service.update_shot_timing, project_id, shot_id, expected_revision, start_seconds, end_seconds)

    @server.tool(annotations=CONTROLLED_WRITE)
    def rename_shot(project_id: str, shot_id: int, expected_revision: str, name: str) -> dict[str, Any]:
        """Rename one shot when the project revision still matches."""
        return _write(write_service.rename_shot, project_id, shot_id, expected_revision, name)

    return server


mcp = create_mcp_server()


if __name__ == "__main__":
    mcp.run()
