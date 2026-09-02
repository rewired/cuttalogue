# Loads the real ComfyUI workflow (API format, exported from the user's own
# graph) and substitutes per-request values into it. Node IDs below are
# hardcoded to match backend/app/workflows/R2V_H3_V1.json specifically - this
# file is deliberately the only place those IDs are hardcoded, so a
# re-export with renumbered nodes only needs updating here.
import copy
import json
from pathlib import Path

WORKFLOW_PATH = Path(__file__).parent / "workflows" / "R2V_H3_V1.json"
BASE_WORKFLOW: dict = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))

PROMPT_NODE_ID = "171"  # PrimitiveStringMultiline -> MiniMaxH3ReferenceToVideo.prompt
SEED_NODE_ID = "152"  # easy seed
FRAME_COUNT_NODE_ID = "244"  # INTConstant "NUM_FRAMES" -> MiniMaxH3ReferenceToVideo.length
FPS_NODE_ID = "245"  # FloatConstant -> CreateVideo.fps
REFERENCE_NODE_ID = "136"  # MiniMaxH3ReferenceToVideo - ref_images.ref_image_N inputs live here
FIRST_REF_IMAGE_NODE_ID = "176"  # LoadImage already wired to ref_images.ref_image_0 via node "177"
AUDIO_NODE_ID = "141"  # LoadAudioUI, wired to MiniMaxH3ReferenceToVideo.ref_audios.ref_audio_0.
# The exported graph has this hardcoded to a leftover manual test - an
# unrelated "audio": "some-old-vocal-file.wav" with start_time/end_time/
# duration carved out of a completely different source file. That must
# never reach ComfyUI once CUTTAlogue is driving generation (see comfy.py).

# The exported graph also contains an unwired VHS_LoadVideo node. This adapter
# rejects Extend before upload/submission instead of accepting unusable input.
# Continuation can be enabled when a compatible workflow is installed.


def build_workflow_payload(
    prompt_text: str,
    reference_filenames: list[str],
    seed: int,
    frame_count: int | None = None,
    fps: float | None = None,
    lip_sync_filename: str | None = None,
    lip_sync_duration: float | None = None,
) -> dict:
    """Returns the real workflow with prompt/seed/reference images/frame
    count/fps/lip-sync audio substituted in. `seed` is the already-resolved
    value (the caller picks a random one if none was given) so this function
    only ever deals with a concrete int. `lip_sync_filename` is the
    ComfyUI-side filename of an already-uploaded
    audio file that comfy.py has rendered to exactly `lip_sync_duration`
    seconds (H3's own render duration, not the editorial cut duration) - the
    loader is pointed at that whole file from its own start rather than
    re-slicing it with a stale time range.
    """
    workflow = copy.deepcopy(BASE_WORKFLOW)

    workflow[PROMPT_NODE_ID]["inputs"]["value"] = prompt_text
    workflow[SEED_NODE_ID]["inputs"]["seed"] = seed
    if frame_count is not None:
        workflow[FRAME_COUNT_NODE_ID]["inputs"]["value"] = frame_count
    if fps is not None:
        workflow[FPS_NODE_ID]["inputs"]["value"] = fps
    if lip_sync_filename is not None:
        audio_inputs = workflow[AUDIO_NODE_ID]["inputs"]
        audio_inputs["audio"] = lip_sync_filename
        audio_inputs["start_time"] = 0.0
        if lip_sync_duration is not None:
            audio_inputs["end_time"] = lip_sync_duration
            audio_inputs["duration"] = lip_sync_duration

    # One LoadImage + ImageScaleDownToSize pair per reference, wired into
    # MiniMaxH3ReferenceToVideo's ref_images.ref_image_N inputs. The first
    # reference reuses the pair already in the exported graph (node "176"/
    # "177", already wired to ref_image_0); further references duplicate
    # that same two-node shape under new IDs.
    ref_node = workflow[REFERENCE_NODE_ID]
    for index, filename in enumerate(reference_filenames):
        if index == 0:
            workflow[FIRST_REF_IMAGE_NODE_ID]["inputs"]["image"] = filename
            continue
        load_id = f"ref_load_{index}"
        scale_id = f"ref_scale_{index}"
        workflow[load_id] = {"class_type": "LoadImage", "inputs": {"image": filename}}
        workflow[scale_id] = {
            "class_type": "ImageScaleDownToSize",
            "inputs": {"size": 2048, "mode": True, "images": [load_id, 0]},
        }
        ref_node["inputs"][f"ref_images.ref_image_{index}"] = [scale_id, 0]

    return workflow
