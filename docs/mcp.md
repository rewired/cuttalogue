# CUTTAlogue MCP

Status: read-only milestone

CUTTAlogue exposes its transport-neutral project services through a local MCP server. The initial server intentionally contains no mutating tools.

## Requirements

Install the backend dependencies:

    backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

Node.js must be available on PATH because read-only prompt compilation invokes the canonical browser H3 compiler instead of maintaining a second grammar.

## STDIO launch

Run from the backend directory:

    .venv\Scripts\python.exe -m app.mcp_server

STDIO is the protocol wire, so the server does not print a startup banner. Logs must go to stderr.

Set CUTTALOGUE_PROJECTS_DIR only when the host should read a non-default project directory.

## Read-only tools

- list_projects
- get_project
- list_shots
- get_shot
- get_shot_direction
- get_camera_segments
- validate_camera_path
- evaluate_camera_path
- compile_shot_prompt
- get_project_warnings
- get_job_status

Every project result includes a SHA-256 content revision where applicable. Project identifiers are path-confined before any file access.

## Testing

The test uses the official SDK's in-memory client, with no subprocess or port:

    backend\.venv\Scripts\python.exe backend\tests\test_mcp_read_server.py

Write tools remain deferred until expected-revision checks and atomic repository writes are available.
