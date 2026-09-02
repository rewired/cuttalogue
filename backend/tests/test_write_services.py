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
        "assets": [{"id": "lead", "name": "Lead reference", "type": "image"}],
        "scenes": [{"id": "scene-a", "anchors": {"performer": {"position": [0, 1.7, 0]}}}],
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

    first_segment = service.add_camera_segment("project-a", 1, moved["revision"], {
        "startSeconds": 0, "endSeconds": 0.4, "movement": "push_in",
    })
    check(first_segment["segmentIndex"] == 0 and first_segment["segment"]["enabled"] is True, "camera add applies canonical defaults and returns the sorted index")
    second_segment = service.add_camera_segment("project-a", 1, first_segment["revision"], {
        "startSeconds": 0.4, "endSeconds": 0.9, "movement": "pan", "direction": "left",
    })
    updated_segment = service.update_camera_segment(
        "project-a", 1, 1, second_segment["revision"],
        {"movement": "truck", "direction": "right"},
    )
    check(updated_segment["segment"]["movement"] == "truck" and updated_segment["segmentIndex"] == 1, "camera update patches one segment and preserves sorted addressing")
    try:
        service.update_camera_segment(
            "project-a", 1, 1, updated_segment["revision"],
            {"startSeconds": 0.2},
        )
        check(False, "overlapping active camera segments are rejected")
    except WriteValidationError:
        check(True, "overlapping active camera segments are rejected")
    check(repository.read("project-a")["revision"] == updated_segment["revision"], "invalid camera patch leaves the revision unchanged")
    disabled_segment = service.add_camera_segment("project-a", 1, updated_segment["revision"], {
        "startSeconds": 0, "endSeconds": 0.8, "movement": "static_shot", "enabled": False,
    })
    check(disabled_segment["segment"]["enabled"] is False, "disabled camera drafts may overlap active segments")
    removed_segment = service.remove_camera_segment(
        "project-a", 1, disabled_segment["segmentIndex"], disabled_segment["revision"],
    )
    check(removed_segment["removedSegment"]["enabled"] is False, "camera remove returns the deleted segment")
    try:
        service.add_camera_segment("project-a", 1, removed_segment["revision"], {
            "startSeconds": 0.9, "endSeconds": 1, "movement": "teleport",
        })
        check(False, "unsupported camera movement is rejected")
    except WriteValidationError:
        check(True, "unsupported camera movement is rejected")

    assigned = service.assign_scene("project-a", 1, removed_segment["revision"], "scene-a")
    check(assigned["shot"]["sceneId"] == "scene-a", "scene assignment validates and updates one shot")
    anchor = service.set_scene_anchor(
        "project-a", "scene-a", assigned["revision"], "face", [0, 1.9, 0],
    )
    check(anchor["anchor"]["position"] == [0.0, 1.9, 0.0], "scene anchor stores finite 3D coordinates")
    bound = service.bind_camera_target(
        "project-a", 1, anchor["revision"], "lead", "face",
    )
    check(bound["targetBindings"]["lead"] == "face", "camera target binds to an anchor in the assigned scene")
    renamed_anchor = service.set_scene_anchor(
        "project-a", "scene-a", bound["revision"], "closeup", [0, 1.9, 0], "face",
    )
    persisted_shot = repository.read("project-a")["project"]["shots"][0]
    check(persisted_shot["preview"]["targetBindings"]["lead"] == "closeup", "renaming an anchor migrates target bindings for assigned shots")
    unbound = service.bind_camera_target(
        "project-a", 1, renamed_anchor["revision"], "lead", "",
    )
    check("lead" not in unbound["targetBindings"], "empty anchor name clears a camera target binding")
    asset_assigned = service.assign_asset(
        "project-a", 1, unbound["revision"], "lead", "primary_character",
    )
    check(asset_assigned["assetRoles"]["lead"] == "primary_character", "asset assignment stores an allowed prompt role")
    constrained = service.add_constraint(
        "project-a", 1, asset_assigned["revision"], "  No visible text  ",
    )
    check(constrained["constraint"] == "No visible text", "constraint write trims and appends authored text")
    compiled_prompt = service.compile_and_save_prompt(
        "project-a", 1, constrained["revision"],
    )
    persisted_prompt = repository.read("project-a")["project"]["shots"][0]["prompt"]
    check(compiled_prompt["prompt"] == persisted_prompt and "No visible text." in persisted_prompt, "canonical compile-and-save persists the exact H3 result")

    try:
        repository.write("project-a", repository.read("project-a")["project"], "")
        check(False, "repository requires an expected revision")
    except InvalidProjectError:
        check(True, "repository requires an expected revision")

    non_json = repository.read("project-a")["project"]
    non_json["invalidNumber"] = float("nan")
    before_invalid = file.read_bytes()
    try:
        repository.write("project-a", non_json, compiled_prompt["revision"])
        check(False, "repository rejects non-standard JSON numbers")
    except InvalidProjectError:
        check(True, "repository rejects non-standard JSON numbers")
    check(file.read_bytes() == before_invalid, "serialization failure leaves project bytes unchanged")

    shared_revision = compiled_prompt["revision"]
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
        http_shot = response.json()["shot"]["id"]
        camera_response = client.post(f"/api/projects/project-a/shots/{http_shot}/camera", json={
            "expectedRevision": response.json()["revision"], "startSeconds": 0,
            "endSeconds": 0.5, "movement": "arc_shot", "direction": "right",
        })
        check(camera_response.status_code == 200 and camera_response.json()["segment"]["movement"] == "arc_shot", "HTTP adapter adds a typed camera segment")
        camera_patch = client.patch(f"/api/projects/project-a/shots/{http_shot}/camera/0", json={
            "expectedRevision": camera_response.json()["revision"], "amplitude": "small",
        })
        check(camera_patch.status_code == 200 and camera_patch.json()["segment"]["amplitude"] == "small", "HTTP adapter patches a camera segment")
        camera_delete = client.request("DELETE", f"/api/projects/project-a/shots/{http_shot}/camera/0", json={
            "expectedRevision": camera_patch.json()["revision"],
        })
        check(camera_delete.status_code == 200 and camera_delete.json()["removedSegment"]["movement"] == "arc_shot", "HTTP adapter removes a camera segment with revision protection")
        scene_response = client.patch(f"/api/projects/project-a/shots/{http_shot}/scene", json={
            "expectedRevision": camera_delete.json()["revision"], "sceneId": "scene-a",
        })
        check(scene_response.status_code == 200 and scene_response.json()["shot"]["sceneId"] == "scene-a", "HTTP adapter assigns an existing scene")
        anchor_response = client.put("/api/projects/project-a/scenes/scene-a/anchors", json={
            "expectedRevision": scene_response.json()["revision"],
            "name": "performer", "position": [1, 1.8, 0],
        })
        check(anchor_response.status_code == 200 and anchor_response.json()["anchor"]["position"] == [1.0, 1.8, 0.0], "HTTP adapter upserts a finite scene anchor")
        binding_response = client.put(f"/api/projects/project-a/shots/{http_shot}/camera-targets", json={
            "expectedRevision": anchor_response.json()["revision"],
            "targetName": "subject", "anchorName": "performer",
        })
        check(binding_response.status_code == 200 and binding_response.json()["targetBindings"]["subject"] == "performer", "HTTP adapter binds a camera target")
        asset_response = client.put(f"/api/projects/project-a/shots/{http_shot}/assets", json={
            "expectedRevision": binding_response.json()["revision"],
            "assetId": "lead", "role": "primary_character",
        })
        check(asset_response.status_code == 200 and asset_response.json()["assetRoles"]["lead"] == "primary_character", "HTTP adapter assigns a project asset with a role")
        constraint_response = client.post(f"/api/projects/project-a/shots/{http_shot}/constraints", json={
            "expectedRevision": asset_response.json()["revision"], "constraint": "No logos",
        })
        prompt_response = client.post(f"/api/projects/project-a/shots/{http_shot}/prompt/compile-and-save", json={
            "expectedRevision": constraint_response.json()["revision"],
        })
        check(constraint_response.status_code == 200 and prompt_response.status_code == 200 and "No logos." in prompt_response.json()["prompt"], "HTTP adapter appends constraints and saves the canonical prompt")
        stale = client.patch("/api/projects/project-a/shots/1/name", json={
            "expectedRevision": current_revision, "name": "stale",
        })
        check(stale.status_code == 409 and stale.json()["detail"]["code"] == "revision_conflict", "HTTP adapter returns a structured 409 revision conflict")
    finally:
        projects.DATA_DIR = original_data_dir

if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll controlled write service checks passed.")
