"""Regression coverage for atomic, revision-guarded project mutations."""
import json
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.project_repository import InvalidProjectError, ProjectRepository, RevisionConflictError  # noqa: E402
from app.write_services import ProjectWriteService, WriteValidationError  # noqa: E402
from app import projects, write_api  # noqa: E402
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


with tempfile.TemporaryDirectory(prefix="cuttalogue-writes-") as raw:
    root = Path(raw)
    directory = root / "project-a"
    directory.mkdir()
    file = directory / "project.json"
    file.write_text(json.dumps({
        "name": "Write test",
        "audio": {"mix": {"durationSeconds": 10}},
        "shots": [{"id": 1, "startSeconds": 2, "endSeconds": 4, "name": "Existing"}],
    }, indent=2), encoding="utf-8")
    repository = ProjectRepository(root)
    service = ProjectWriteService(repository)
    initial = repository.read("project-a")

    created = service.create_shot("project-a", initial["revision"], 0, 1, "Opening")
    check(created["revision"] != initial["revision"], "successful write returns a new content revision")
    check(created["shot"]["id"] == 1, "created shot receives chronological id")
    check(repository.read("project-a")["project"]["shots"][1]["id"] == 2, "existing shots are renumbered chronologically")
    check(not list(directory.glob(".project-*.tmp")), "atomic write leaves no temporary file")
    check((directory / ".project.lock").exists(), "repository uses a project-local inter-process lock")

    before_stale = file.read_bytes()
    try:
        service.rename_shot("project-a", 1, initial["revision"], "Stale rename")
        check(False, "stale expected revision is rejected")
    except RevisionConflictError as error:
        check(error.current_revision == created["revision"], "revision conflict exposes the current revision")
    check(file.read_bytes() == before_stale, "stale write does not change project bytes")
    try:
        service.update_shot_timing("project-a", 1, initial["revision"], 0, 0)
        check(False, "stale revision takes precedence over payload validation")
    except RevisionConflictError as error:
        check(error.current_revision == created["revision"], "stale revision takes precedence over payload validation")

    renamed = service.rename_shot("project-a", 1, created["revision"], "Renamed")
    check(renamed["shot"]["name"] == "Renamed", "narrow rename updates only the addressed shot")

    try:
        service.update_shot_timing("project-a", 1, renamed["revision"], 0, 2.5)
        check(False, "overlapping timing is rejected")
    except WriteValidationError:
        check(True, "overlapping timing is rejected")
    check(repository.read("project-a")["revision"] == renamed["revision"], "validation failure does not create a revision")

    moved = service.update_shot_timing("project-a", 1, renamed["revision"], 0.5, 1.5)
    check(moved["shot"]["startSeconds"] == 0.5 and moved["shot"]["endSeconds"] == 1.5, "valid timing update persists exact bounds")

    try:
        repository.write("project-a", repository.read("project-a")["project"], "")
        check(False, "repository requires an expected revision")
    except InvalidProjectError:
        check(True, "repository requires an expected revision")

    non_json = repository.read("project-a")["project"]
    non_json["invalidNumber"] = float("nan")
    before_invalid = file.read_bytes()
    try:
        repository.write("project-a", non_json, moved["revision"])
        check(False, "repository rejects non-standard JSON numbers")
    except InvalidProjectError:
        check(True, "repository rejects non-standard JSON numbers")
    check(file.read_bytes() == before_invalid, "serialization failure leaves project bytes unchanged")

    shared_revision = moved["revision"]
    def concurrent_rename(name):
        try:
            return service.rename_shot("project-a", 1, shared_revision, name)["revision"]
        except RevisionConflictError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(concurrent_rename, ["Writer A", "Writer B"]))
    check(sum(isinstance(item, str) for item in outcomes) == 1, "only one concurrent writer with the same revision succeeds")
    check(sum(isinstance(item, RevisionConflictError) for item in outcomes) == 1, "losing concurrent writer receives a revision conflict")
    check(isinstance(json.loads(file.read_text(encoding="utf-8")), dict), "concurrent writes leave a valid project document")

    original_data_dir = projects.DATA_DIR
    try:
        projects.DATA_DIR = root
        app = FastAPI()
        app.include_router(write_api.router)
        client = TestClient(app)
        current_revision = repository.read("project-a")["revision"]
        response = client.post("/api/projects/project-a/shots", json={
            "expectedRevision": current_revision, "startSeconds": 5,
            "endSeconds": 6, "name": "HTTP shot",
        })
        check(response.status_code == 200 and response.json()["shot"]["name"] == "HTTP shot", "HTTP adapter uses the controlled create service")
        stale = client.patch("/api/projects/project-a/shots/1/name", json={
            "expectedRevision": current_revision, "name": "stale",
        })
        check(stale.status_code == 409 and stale.json()["detail"]["code"] == "revision_conflict", "HTTP adapter returns a structured 409 revision conflict")
    finally:
        projects.DATA_DIR = original_data_dir

if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll controlled write service checks passed.")
