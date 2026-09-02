"""Regression coverage for explicit revision-checked generation startup."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import generation_service as generation_module  # noqa: E402
from app import comfy, jobs  # noqa: E402
from app.generation_service import GenerationService  # noqa: E402
from app.project_repository import ProjectRepository, RevisionConflictError  # noqa: E402
from app.write_services import WriteValidationError  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


async def main() -> None:
    cancelled_job = jobs.create_job()
    cancelled_job.cancel_requested = True
    try:
        comfy._ensure_not_cancelled(cancelled_job)
        check(False, "Comfy generation observes a requested cancellation")
    except jobs.JobCancelled:
        check(True, "Comfy generation observes a requested cancellation")
    jobs._jobs.pop(cancelled_job.id, None)
    with tempfile.TemporaryDirectory(prefix="cuttalogue-path-") as path_raw:
        try:
            comfy._confined_project_file(Path(path_raw), "../escape.png")
            check(False, "generation rejects asset paths outside the project")
        except comfy.GenerationStartError:
            check(True, "generation rejects asset paths outside the project")

    with tempfile.TemporaryDirectory(prefix="cuttalogue-generation-") as raw:
        root = Path(raw)
        directory = root / "project-a"
        directory.mkdir()
        (directory / "project.json").write_text(json.dumps({
            "assets": [
                {"id": "support", "type": "image"},
                {"id": "lead", "type": "image"},
                {"id": "clip", "type": "video"},
            ],
            "shots": [{
                "id": 1, "startSeconds": 0, "endSeconds": 2,
                "prompt": "Persisted canonical prompt", "seed": 7,
                "assetIds": ["support", "clip", "lead"],
                "assetRoles": {
                    "support": "supporting_character",
                    "lead": "primary_character",
                },
                "videoRefs": {"clip": {"mode": "extend", "startFrame": 12, "frameCount": 25}},
            }],
        }), encoding="utf-8")
        repository = ProjectRepository(root)
        service = GenerationService(repository)
        revision = repository.read("project-a")["revision"]
        calls = []

        async def fake_start(project, project_directory, shot, body):
            calls.append((project, project_directory, shot, body))
            return {"jobId": "job-test", "takeId": "take-test"}

        original = generation_module.start_generation_job
        generation_module.start_generation_job = fake_start
        try:
            started = await service.start_generation("project-a", 1, revision, 99)
            check(started["jobId"] == "job-test" and started["revision"] == revision, "generation service returns job ids with the inspected revision")
            body = calls[0][3]
            check(body["prompt"] == "Persisted canonical prompt", "generation uses only the persisted shot prompt")
            check(body["referenceAssetIds"] == ["lead", "support"], "generation derives canonical role-ordered references")
            check(body["extendAssetId"] == "clip" and body["extendStartFrame"] == 12 and body["extendFrameCount"] == 25, "generation derives the stored extend-video configuration")
            check(calls[0][1] == directory, "generation receives the repository-confined project directory")
            try:
                await service.start_generation("project-a", 1, "stale", None)
                check(False, "generation rejects a stale project revision before starting a job")
            except RevisionConflictError:
                check(True, "generation rejects a stale project revision before starting a job")
            project = repository.read("project-a")["project"]
            project["shots"][0]["prompt"] = ""
            next_record = repository.write("project-a", project, revision)
            try:
                await service.start_generation("project-a", 1, next_record["revision"], None)
                check(False, "generation rejects a shot without a persisted prompt")
            except WriteValidationError:
                check(True, "generation rejects a shot without a persisted prompt")
        finally:
            generation_module.start_generation_job = original


asyncio.run(main())
if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll generation service checks passed.")
