"""In-memory protocol tests for the read-only MCP server."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp import Client  # noqa: E402
from app.mcp_server import create_mcp_server  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cuttalogue-mcp-test-") as raw:
        root = Path(raw)
        directory = root / "mcp-project"
        directory.mkdir()
        (directory / "project.json").write_text(json.dumps({
            "name": "MCP test",
            "scenes": [{"id": "scene-1"}],
            "shots": [{
                "id": 1, "startSeconds": 0, "endSeconds": 5, "sceneId": "scene-1",
                "direction": {"camera": [{"startSeconds": 0, "endSeconds": 5, "movement": "push_in"}]},
            }],
        }), encoding="utf-8")

        server = create_mcp_server(root)
        async with Client(server) as client:
            tools = await client.list_tools()
            names = {tool.name for tool in tools.tools}
            expected = {
                "list_projects", "get_project", "list_shots", "get_shot",
                "get_shot_direction", "get_camera_segments", "get_project_warnings",
            }
            check(names == expected, "MCP exposes exactly the first read-only tool set")

            projects = await client.call_tool("list_projects", {})
            check(not projects.is_error and projects.structured_content["projects"][0]["id"] == "mcp-project", "list_projects returns structured service data")
            camera = await client.call_tool("get_camera_segments", {"project_id": "mcp-project", "shot_id": 1})
            check(not camera.is_error and camera.structured_content["cameraSegments"][0]["movement"] == "push_in", "camera tool returns authoritative Direction segments")
            missing = await client.call_tool("get_shot", {"project_id": "mcp-project", "shot_id": 99})
            check(missing.is_error, "domain errors become MCP tool errors")
            check(client.protocol_version is not None, "in-memory client negotiates an MCP protocol version")


asyncio.run(main())
if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll read-only MCP checks passed.")
