"""CUTTAlogue read-only MCP server over local STDIO."""
import os
from pathlib import Path
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository
from .projects import DATA_DIR
from .read_services import EntityNotFoundError, ProjectReadService


EXPECTED_READ_ERRORS = (EntityNotFoundError, InvalidProjectError, ProjectNotFoundError)


def _read(operation, *args) -> Any:
    try:
        return operation(*args)
    except EXPECTED_READ_ERRORS as error:
        raise ToolError(str(error)) from error


def create_mcp_server(data_dir: Path | None = None) -> MCPServer:
    root = data_dir or Path(os.environ.get("CUTTALOGUE_PROJECTS_DIR", DATA_DIR))
    service = ProjectReadService(ProjectRepository(root))
    server = MCPServer(
        "CUTTAlogue",
        instructions=(
            "Read CUTTAlogue projects, shots, Direction data, camera segments, "
            "and validation warnings. This milestone is read-only."
        ),
    )

    @server.tool()
    def list_projects() -> dict[str, Any]:
        """List CUTTAlogue projects with content revisions and shot counts."""
        return {"projects": _read(service.list_projects)}

    @server.tool()
    def get_project(project_id: str) -> dict[str, Any]:
        """Read one complete CUTTAlogue project by id."""
        return _read(service.get_project, project_id)

    @server.tool()
    def list_shots(project_id: str) -> dict[str, Any]:
        """List all shots in one CUTTAlogue project."""
        return _read(service.list_shots, project_id)

    @server.tool()
    def get_shot(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read one shot by project id and numeric shot id."""
        return _read(service.get_shot, project_id, shot_id)

    @server.tool()
    def get_shot_direction(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read normalized Camera, Lighting, Subject, Prop, and Beat Direction."""
        return _read(service.get_shot_direction, project_id, shot_id)

    @server.tool()
    def get_camera_segments(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read the authoritative shot.direction.camera segments for one shot."""
        return _read(service.get_camera_segments, project_id, shot_id)

    @server.tool()
    def get_project_warnings(project_id: str) -> dict[str, Any]:
        """Validate project timing and scene references without changing data."""
        return _read(service.get_project_warnings, project_id)

    return server


mcp = create_mcp_server()


if __name__ == "__main__":
    mcp.run()
