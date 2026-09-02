"""Exact graph-input contract checks for the bundled MiniMax H3 workflow."""
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import comfy_workflow_template as workflow_template  # noqa: E402


def check(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"ok - {label}")


workflow_template.validate_workflow_contract(workflow_template.BASE_WORKFLOW)
print("ok - bundled workflow node classes and links match the adapter contract")

broken = copy.deepcopy(workflow_template.BASE_WORKFLOW)
broken[workflow_template.REFERENCE_NODE_ID]["inputs"]["prompt"] = ["wrong", 0]
try:
    workflow_template.validate_workflow_contract(broken)
    raise AssertionError("broken prompt link was accepted")
except RuntimeError as error:
    check("prompt" in str(error), "a changed H3 prompt link fails fast")

prompt = "unique CUTTAlogue prompt reaches H3 byte-for-byte"
references = ["lead.png", "support.png", "room.png"]
frame_count = 243
fps = 24
duration = frame_count / fps
workflow = workflow_template.build_workflow_payload(
    prompt,
    references,
    123456,
    frame_count=frame_count,
    fps=fps,
    lip_sync_filename="shot-vocal.flac",
    lip_sync_duration=duration,
)

h3_inputs = workflow[workflow_template.REFERENCE_NODE_ID]["inputs"]
check(
    h3_inputs["prompt"] == [workflow_template.PROMPT_NODE_ID, 0]
    and workflow[workflow_template.PROMPT_NODE_ID]["inputs"]["value"] == prompt,
    "the exact prompt string reaches the H3 prompt input",
)
check(
    h3_inputs["length"] == [workflow_template.FRAME_COUNT_NODE_ID, 0]
    and workflow[workflow_template.FRAME_COUNT_NODE_ID]["inputs"]["value"] == frame_count,
    "the exact legal frame count reaches the H3 length input",
)
check(
    workflow["130"]["inputs"]["fps"] == [workflow_template.FPS_NODE_ID, 0]
    and workflow[workflow_template.FPS_NODE_ID]["inputs"]["value"] == fps,
    "24 fps reaches CreateVideo through the contracted node",
)
check(
    workflow["129"]["inputs"]["noise_seed"] == [workflow_template.SEED_NODE_ID, 0]
    and workflow[workflow_template.SEED_NODE_ID]["inputs"]["seed"] == 123456,
    "the exact seed reaches RandomNoise through the contracted node",
)

reference_slots = sorted(key for key in h3_inputs if key.startswith("ref_images.ref_image_"))
check(reference_slots == [
    "ref_images.ref_image_0",
    "ref_images.ref_image_1",
    "ref_images.ref_image_2",
], "H3 receives exactly three contiguous image-reference slots")
check(
    workflow[workflow_template.FIRST_REF_IMAGE_NODE_ID]["inputs"]["image"] == references[0]
    and workflow["ref_load_1"]["inputs"]["image"] == references[1]
    and workflow["ref_load_2"]["inputs"]["image"] == references[2],
    "reference filenames preserve canonical presentation order",
)

audio_inputs = workflow[workflow_template.AUDIO_NODE_ID]["inputs"]
check(h3_inputs["ref_audios.ref_audio_0"] == [workflow_template.AUDIO_NODE_ID, 0], "H3 audio slot remains linked")
check(audio_inputs["audio"] == "shot-vocal.flac", "the generated vocal filename replaces the exported test file")
check(audio_inputs["start_time"] == 0.0, "the generated vocal always starts at zero")
check(audio_inputs["end_time"] == duration and audio_inputs["duration"] == duration, "audio duration exactly matches H3 frames")

without_images = workflow_template.build_workflow_payload(
    prompt,
    [],
    123456,
    frame_count=frame_count,
    fps=fps,
    lip_sync_filename="shot-vocal.flac",
    lip_sync_duration=duration,
)
empty_h3_inputs = without_images[workflow_template.REFERENCE_NODE_ID]["inputs"]
check(
    not any(key.startswith("ref_images.ref_image_") for key in empty_h3_inputs),
    "zero requested images produces zero H3 image slots",
)
check(
    workflow_template.FIRST_REF_IMAGE_NODE_ID not in without_images and "177" not in without_images,
    "zero requested images removes the exported stale image nodes",
)
check(
    workflow_template.FIRST_REF_IMAGE_NODE_ID in workflow_template.BASE_WORKFLOW,
    "per-request cleanup never mutates the bundled workflow template",
)

invalid_cases = [
    {"frame_count": 242, "fps": 24, "lip_sync_filename": "a.flac", "lip_sync_duration": 242 / 24},
    {"frame_count": 243, "fps": 25, "lip_sync_filename": "a.flac", "lip_sync_duration": 243 / 25},
    {"frame_count": 243, "fps": 24, "lip_sync_filename": "a.flac", "lip_sync_duration": 1},
]
for kwargs in invalid_cases:
    try:
        workflow_template.build_workflow_payload(prompt, [], 1, **kwargs)
        raise AssertionError(f"invalid workflow inputs were accepted: {kwargs}")
    except ValueError:
        pass
print("ok - invalid frame lattice, fps, and audio duration are rejected")

print("\nAll H3 workflow contract checks passed.")
