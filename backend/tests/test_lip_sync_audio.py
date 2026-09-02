# Regression coverage for Phase 1 lip-sync audio (docs/CUTTAlogue-idea.md's
# lip-sync section + the Generate pipeline in comfy.py). The repo has no test
# framework installed (see frontend/tests/references.test.js for the same
# dependency-free pattern used on the JS side) - this is a plain script using
# only what the project already depends on at runtime: real ffmpeg/ffprobe
# (media.py already shells out to both) and FastAPI's TestClient (part of
# fastapi/starlette, already in requirements.txt - no extra install).
#
# Run with:
#   backend/.venv/Scripts/python.exe backend/tests/test_lip_sync_audio.py
import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import comfy_workflow_template, frames, media  # noqa: E402
from app import projects as projects_module  # noqa: E402
from app import settings as settings_module  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


def ffprobe_duration(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(json.loads(proc.stdout)["format"]["duration"])


def mean_volume_db(path: Path, start: float, duration: float) -> float:
    # ffmpeg's volumedetect filter prints "mean_volume: -N dB" to stderr -
    # used below to tell real (loud) source audio apart from silence, so the
    # padding test can't be fooled by e.g. a loop that happens to land on the
    # right duration.
    proc = subprocess.run(
        [
            "ffmpeg", "-v", "info", "-ss", f"{start:.3f}", "-i", str(path), "-t", f"{duration:.3f}",
            "-af", "volumedetect", "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
    )
    for line in proc.stderr.splitlines():
        if "mean_volume" in line:
            return float(line.strip().split(":")[1].replace("dB", "").strip())
    raise RuntimeError(f"could not parse mean_volume from ffmpeg output:\n{proc.stderr}")


def make_tone(path: Path, duration_seconds: float) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration_seconds}", "-ar", "32000", "-ac", "1", str(path)],
        capture_output=True,
        check=True,
    )


async def _noop_progress(_fraction: float) -> None:
    return None


def render_snippet(source: Path, start: float, duration: float, output: Path) -> None:
    cmd = media.audio_snippet_cmd(source, start, duration, output)
    asyncio.run(media.run_ffmpeg_with_progress(cmd, duration, _noop_progress))


TMP_DIR = Path(tempfile.mkdtemp(prefix="cuttalogue-lipsync-test-"))

try:
    source = TMP_DIR / "vocal_100s.wav"
    make_tone(source, 100.0)

    # --- Case A: normal shot (start=20.0, end=30.0) ---------------------------
    cut_duration_a = 10.0
    frame_count_a = frames.h3_frame_count(cut_duration_a)
    h3_duration_a = frame_count_a / frames.H3_FPS
    out_a = TMP_DIR / "case_a.flac"
    render_snippet(source, 20.0, h3_duration_a, out_a)
    actual_a = ffprobe_duration(out_a)
    check(
        abs(actual_a - h3_duration_a) < 0.05,
        f"Case A: output duration {actual_a:.3f}s matches h3_frame_count(10.0)/H3_FPS = {h3_duration_a:.3f}s",
    )

    # --- Case B: H3 overhang - render duration > editorial cut duration ------
    cut_duration_b = 9.7
    desired_b = round(cut_duration_b * frames.H3_FPS)
    frame_count_b = frames.h3_frame_count(cut_duration_b)
    h3_duration_b = frame_count_b / frames.H3_FPS
    check(frame_count_b > desired_b, f"Case B: precondition - h3_frame_count snaps {desired_b} frames up to {frame_count_b} (real overhang)")
    check(h3_duration_b > cut_duration_b, f"Case B: H3 render duration {h3_duration_b:.3f}s exceeds cut duration {cut_duration_b}s")
    out_b = TMP_DIR / "case_b.flac"
    render_snippet(source, 50.0, h3_duration_b, out_b)
    actual_b = ffprobe_duration(out_b)
    check(
        abs(actual_b - h3_duration_b) < 0.05,
        f"Case B: audio duration {actual_b:.3f}s matches H3 render duration, not the {cut_duration_b}s cut duration",
    )

    # --- Case C: source ends during H3 padding --------------------------------
    # vocal source is 100s; a shot starting at 95.0 needing 5.5s runs 0.5s
    # past the end of the source.
    required_c = 5.5
    out_c = TMP_DIR / "case_c.flac"
    render_snippet(source, 95.0, required_c, out_c)
    actual_c = ffprobe_duration(out_c)
    check(abs(actual_c - required_c) < 0.05, f"Case C: output still lasts exactly {required_c}s ({actual_c:.3f}s), not truncated")
    head_db = mean_volume_db(out_c, start=0.0, duration=4.0)
    tail_db = mean_volume_db(out_c, start=required_c - 0.4, duration=0.35)
    check(head_db > -40, f"Case C: leading segment still has real source audio (mean_volume {head_db:.1f} dB)")
    check(tail_db < -40, f"Case C: trailing overhang is silence (mean_volume {tail_db:.1f} dB), not a loop of the source")

    # --- Case E: workflow substitution -----------------------------------------
    expected_workflow_duration = 175 / frames.H3_FPS
    workflow = comfy_workflow_template.build_workflow_payload(
        "test prompt", [], 12345,
        frame_count=175,
        fps=frames.H3_FPS,
        lip_sync_filename="generated-shot.flac",
        lip_sync_duration=expected_workflow_duration,
    )
    audio_inputs = workflow[comfy_workflow_template.AUDIO_NODE_ID]["inputs"]
    check(audio_inputs["audio"] == "generated-shot.flac", "Case E: workflow audio loader points at the generated filename")
    check(audio_inputs["start_time"] == 0.0, "Case E: start_time reset to 0.0 (no stale re-slice offset)")
    check(audio_inputs["end_time"] == expected_workflow_duration, "Case E: end_time matches the generated file's own H3 duration")
    check(audio_inputs["duration"] == expected_workflow_duration, "Case E: duration matches the generated file's own H3 duration")
    check(
        audio_inputs["audio"] != "airtone-dnb-banger-08-video-vocal-slicer-04-voxonly.wav",
        "Case E: the old manual-test workflow audio filename is gone",
    )

    # --- Case D: missing vocal fails cleanly before ComfyUI submission --------
    from fastapi.testclient import TestClient  # noqa: E402

    from app.main import app  # noqa: E402

    original_data_dir = projects_module.DATA_DIR
    original_settings_file = settings_module.SETTINGS_FILE
    try:
        test_data_dir = TMP_DIR / "projects"
        test_data_dir.mkdir(parents=True, exist_ok=True)
        projects_module.DATA_DIR = test_data_dir

        test_settings_file = TMP_DIR / "settings.json"
        test_settings_file.write_text(
            json.dumps({"providers": {"comfy": {"baseUrl": "http://comfy.invalid:9999", "apiKey": "", "mode": "pod"}}}),
            encoding="utf-8",
        )
        settings_module.SETTINGS_FILE = test_settings_file

        project_id = "test-proj"
        project_dir_path = test_data_dir / project_id
        project_dir_path.mkdir(parents=True, exist_ok=True)
        project_payload = {
            "shots": [{"id": 1, "startSeconds": 0.0, "endSeconds": 10.0, "prompt": "", "assetIds": [], "assetRoles": {}}],
            "assets": [],
            "audio": {},  # no vocal track uploaded
            "video": {"fpsNumerator": 25, "fpsDenominator": 1, "frameRule": {"stride": 8, "offset": 1}},
        }
        (project_dir_path / "project.json").write_text(json.dumps(project_payload), encoding="utf-8")

        client = TestClient(app)
        res = client.post(
            f"/api/projects/{project_id}/shots/1/generate",
            json={"prompt": "a test prompt", "referenceAssetIds": []},
        )
        check(res.status_code == 400, f"Case D: missing vocal track returns HTTP 400 (got {res.status_code})")
        detail = (res.json() or {}).get("detail", "")
        check("vocal" in detail.lower(), f"Case D: error message mentions the vocal track ({detail!r})")
    finally:
        projects_module.DATA_DIR = original_data_dir
        settings_module.SETTINGS_FILE = original_settings_file

finally:
    shutil.rmtree(TMP_DIR, ignore_errors=True)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nAll lip-sync audio checks passed.")
