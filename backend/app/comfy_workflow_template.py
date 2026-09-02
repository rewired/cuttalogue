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
    frame_count: int,
    fps: float,
    lip_sync_filename: str,
    lip_sync_duration: float,
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
    validate_workflow_contract(BASE_WORKFLOW)
    if not isinstance(prompt_text, str) or not prompt_text.strip():
        raise ValueError("prompt_text must be a non-empty string")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    if not isinstance(reference_filenames, list) or not all(
        isinstance(filename, str) and filename for filename in reference_filenames
    ):
        raise ValueError("reference_filenames must contain non-empty strings")
    if len(reference_filenames) > 9:
        raise ValueError("MiniMax H3 supports at most nine image references")
    if isinstance(frame_count, bool) or not isinstance(frame_count, int) or frame_count < 5 or frame_count % 17 != 5:
        raise ValueError("frame_count must be on MiniMax H3's 17n+5 lattice")
    if fps != 24:
        raise ValueError("MiniMax H3 generation fps must be 24")
    if not lip_sync_filename or abs(lip_sync_duration - frame_count / fps) > 1e-9:
        raise ValueError("lip-sync audio duration must exactly match the H3 render duration")
    workflow = copy.deepcopy(BASE_WORKFLOW)



    workflow[PROMPT_NODE_ID]["inputs"]["value"] = prompt_text
    workflow[SEED_NODE_ID]["inputs"]["seed"] = seed
    workflow[FRAME_COUNT_NODE_ID]["inputs"]["value"] = frame_count
    workflow[FPS_NODE_ID]["inputs"]["value"] = fps
    audio_inputs = workflow[AUDIO_NODE_ID]["inputs"]
    audio_inputs["audio"] = lip_sync_filename
    audio_inputs["start_time"] = 0.0
    audio_inputs["end_time"] = lip_sync_duration
    audio_inputs["duration"] = lip_sync_duration

    # One LoadImage + ImageScaleDownToSize pair per reference, wired into
    # MiniMaxH3ReferenceToVideo's ref_images.ref_image_N inputs. The first
    # reference reuses the pair already in the exported graph (node "176"/
    # "177", already wired to ref_image_0); further references duplicate
    # that same two-node shape under new IDs.
    ref_node = workflow[REFERENCE_NODE_ID]
    for input_name in list(ref_node["inputs"]):
        if input_name.startswith("ref_images.ref_image_"):
            ref_node["inputs"].pop(input_name)
    if not reference_filenames:
        workflow.pop(FIRST_REF_IMAGE_NODE_ID)
        workflow.pop("177")
    for index, filename in enumerate(reference_filenames):
        if index == 0:
            workflow[FIRST_REF_IMAGE_NODE_ID]["inputs"]["image"] = filename
            ref_node["inputs"]["ref_images.ref_image_0"] = ["177", 0]
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

def validate_workflow_contract(workflow: dict) -> None:
    """Fail fast when a re-export no longer matches CUTTAlogue's adapter."""
    expected_nodes = {
        REFERENCE_NODE_ID: "MiniMaxH3ReferenceToVideo",
        PROMPT_NODE_ID: "PrimitiveStringMultiline",
        SEED_NODE_ID: "easy seed",
        FRAME_COUNT_NODE_ID: "INTConstant",
        FPS_NODE_ID: "FloatConstant",
        FIRST_REF_IMAGE_NODE_ID: "LoadImage",
        "177": "ImageScaleDownToSize",
        AUDIO_NODE_ID: "LoadAudioUI",
        "129": "RandomNoise",
        "130": "CreateVideo",
    }
    for node_id, class_type in expected_nodes.items():
        node = workflow.get(node_id)
        if not isinstance(node, dict) or node.get("class_type") != class_type:
            actual = node.get("class_type") if isinstance(node, dict) else None
            raise RuntimeError(
                f"R2V_H3_V1 workflow contract mismatch at node {node_id}: "
                f"expected {class_type}, found {actual}"
            )

    expected_links = [
        (REFERENCE_NODE_ID, "prompt", [PROMPT_NODE_ID, 0]),
        (REFERENCE_NODE_ID, "length", [FRAME_COUNT_NODE_ID, 0]),
        (REFERENCE_NODE_ID, "ref_images.ref_image_0", ["177", 0]),
        (REFERENCE_NODE_ID, "ref_audios.ref_audio_0", [AUDIO_NODE_ID, 0]),
        ("177", "images", [FIRST_REF_IMAGE_NODE_ID, 0]),
        ("129", "noise_seed", [SEED_NODE_ID, 0]),
        ("130", "fps", [FPS_NODE_ID, 0]),
    ]
    for node_id, input_name, expected in expected_links:
        actual = workflow[node_id].get("inputs", {}).get(input_name)
        if actual != expected:
            raise RuntimeError(
                f"R2V_H3_V1 workflow link mismatch at {node_id}.{input_name}: "
                f"expected {expected}, found {actual}"
            )
