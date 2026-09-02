# CUTTAlogue MCP

Status: controlled-write milestone in progress; shot and camera Direction writes available

CUTTAlogue exposes its transport-neutral project services through a local MCP server. Mutations are narrow typed operations; there is no generic project JSON writer.

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

## Controlled-write tools

- create_shot
- update_shot_timing
- rename_shot
- add_camera_segment
- update_camera_segment
- remove_camera_segment

Every write requires `expected_revision` from a fresh read. Write failures return MCP errors with structured `code` and `message` fields; revision conflicts additionally contain `expectedRevision` and `currentRevision`. Failed writes do not change the project. Writes hold a project-local inter-process lock across revision verification and use same-directory temporary files plus atomic replacement.

Camera segment times are shot-relative. Active segments must stay inside the shot and may touch but not overlap. Disabled draft segments may overlap. Segment mutations address the current start-time-sorted `segment_index`; add and update responses return the resulting sorted index. Removal is explicitly marked destructive in MCP tool metadata.

## Testing

The test uses the official SDK's in-memory client, with no subprocess or port:

    backend\.venv\Scripts\python.exe backend\tests\test_mcp_read_server.py

The controlled-write test suite is dependency-free:

    backend\.venv\Scripts\python.exe backend\tests\test_write_services.py
