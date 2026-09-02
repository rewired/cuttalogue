"""Dependency-free tests for the transport-neutral read service layer."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.project_repository import InvalidProjectError, ProjectRepository  # noqa: E402
from app.prompt_service import PromptCompilationError  # noqa: E402
from app.read_services import EntityNotFoundError, ProjectReadService  # noqa: E402
from app import projects, read_api  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


with tempfile.TemporaryDirectory(prefix="cuttalogue-read-services-") as raw:
    root = Path(raw)
    directory = root / "project-a"
    directory.mkdir()
    payload = {
        "name": "Service test",
        "scenes": [{"id": "scene-a", "defaultCamera": {
            "position": [0, 1.6, 4], "target": [0, 1.6, 0], "focalLengthMm": 35,
        }}],
        "shots": [{
            "id": 1, "startSeconds": 0, "endSeconds": 4, "sceneId": "scene-a",
            "direction": {"camera": [{"startSeconds": 0, "endSeconds": 4, "movement": "push_in"}]},
        }],
    }
    file = directory / "project.json"
    file.write_text(json.dumps(payload), encoding="utf-8")
    repository = ProjectRepository(root)
    service = ProjectReadService(repository)

    listed = service.list_projects()
    check(len(listed) == 1 and listed[0]["shotCount"] == 1, "project summaries come from the repository")
    check(len(listed[0]["revision"]) == 64, "project summaries expose a content revision")
    record = service.get_project("project-a")
    check(record["project"]["name"] == "Service test", "get_project returns the canonical project")
    check(service.get_shot("project-a", 1)["shot"]["sceneId"] == "scene-a", "get_shot returns one shot")
    check(len(service.get_camera_segments("project-a", 1)["cameraSegments"]) == 1, "camera segments have a dedicated service")
    check(service.validate_camera_path("project-a", 1)["valid"], "backend camera path validates through the shared service")
    check(service.evaluate_camera_path("project-a", 1, 4)["pose"]["position"] == [0.0, 1.6, 3.0], "backend camera path evaluates through the shared service")
    check("The camera pushes in" in service.compile_shot_prompt("project-a", 1)["prompt"], "canonical H3 prompt compiles through the shared service")
    check(service.get_project_warnings("project-a")["valid"], "valid references and timings produce no warnings")

    payload["shots"][0]["sceneId"] = "missing"
    file.write_text(json.dumps(payload), encoding="utf-8")
    warning_result = service.get_project_warnings("project-a")
    check(warning_result["warnings"][0]["code"] == "unresolved_scene", "unresolved scenes produce stable warning codes")
    check(record["revision"] != service.get_project("project-a")["revision"], "revision changes when project content changes")

    try:
        service.get_shot("project-a", 99)
        check(False, "missing shots are rejected")
    except EntityNotFoundError:
        check(True, "missing shots are rejected")

    for project_id in ("../escape", "bad/name", ""):
        try:
            repository.read(project_id)
            check(False, f"path-bearing project id {project_id!r} is rejected")
        except InvalidProjectError:
            check(True, f"path-bearing project id {project_id!r} is rejected")

    check(read_api.translate(PromptCompilationError("compiler unavailable")).status_code == 503, "HTTP adapter distinguishes compiler availability from invalid input")

    original_data_dir = projects.DATA_DIR
    try:
        projects.DATA_DIR = root
        app = FastAPI()
        app.include_router(read_api.router)
        client = TestClient(app)
        check(client.get("/api/projects/project-a/shots").status_code == 200, "HTTP adapter exposes list_shots")
        direction = client.get("/api/projects/project-a/shots/1/direction")
        check(direction.status_code == 200 and len(direction.json()["direction"]["camera"]) == 1, "HTTP adapter exposes shot Direction")
        evaluation = client.get("/api/projects/project-a/shots/1/camera/evaluation", params={"time_seconds": 4})
        expected_pose = service.evaluate_camera_path("project-a", 1, 4)["pose"]["position"]
        check(evaluation.status_code == 200 and evaluation.json()["pose"]["position"] == expected_pose, "HTTP adapter exposes shared camera evaluation")
        compiled = client.get("/api/projects/project-a/shots/1/prompt/compiled")
        check(compiled.status_code == 200 and "The camera pushes in" in compiled.json()["prompt"], "HTTP adapter exposes canonical prompt compilation")
        check(client.get("/api/projects/project-a/shots/99").status_code == 404, "HTTP adapter maps missing entities to 404")
        check(client.get("/api/projects/project-a/warnings").json()["warnings"][0]["code"] == "unresolved_scene", "HTTP warnings use service results")
    finally:
        projects.DATA_DIR = original_data_dir

if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll read service checks passed.")
