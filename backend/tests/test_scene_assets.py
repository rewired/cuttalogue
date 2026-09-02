"""Dependency-free regression checks for scene asset ingestion."""
import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import assets, media  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


check(media.guess_asset_type("room.PLY") == "pointcloud", "PLY is recognized as a point-cloud scene")
check(media.guess_asset_type("room.splat") == "pointcloud", "SPLAT is recognized as a point-cloud scene")
check(media.guess_asset_type("blockout.GLB") == "model3d", "GLB is recognized as a 3D blockout")
check(assets._default_kind("pointcloud") == "scene_splat", "point clouds receive the scene kind")
check(assets._default_kind("model3d") == "scene_blockout", "GLBs receive the blockout kind")

try:
    assets._safe_upload_filename("../escape.ply")
    check(False, "path-bearing upload names are rejected")
except Exception as error:
    check(getattr(error, "status_code", None) == 400, "path-bearing upload names are rejected")


async def descriptor_check() -> None:
    original_probe = media.probe

    async def forbidden_probe(_path: Path) -> dict:
        raise AssertionError("ffprobe must not run for scene geometry")

    try:
        media.probe = forbidden_probe
        with tempfile.TemporaryDirectory(prefix="cuttalogue-scene-test-") as raw_dir:
            directory = Path(raw_dir)
            scene_file = directory / "set.splat"
            scene_file.write_bytes(b"SPLAT")
            descriptor = await assets._describe_asset_file(directory, "asset1", scene_file, scene_file.name)
            check(descriptor["type"] == "pointcloud", "scene descriptor preserves the point-cloud type")
            check(descriptor["metadata"]["format"] == "splat", "scene descriptor stores its format")
            check(descriptor["metadata"]["sizeBytes"] == 5, "scene descriptor stores its byte size")
            check(descriptor["thumbnailPath"] is None, "scene geometry does not enter the media thumbnail pipeline")
    finally:
        media.probe = original_probe


asyncio.run(descriptor_check())

if failures:
    print(f"\n{failures} failure(s)")
    raise SystemExit(1)
print("\nAll scene asset backend checks passed.")
