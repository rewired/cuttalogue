# Placeholder ComfyUI workflow (API format) and the substitution logic that
# turns it into a submittable /prompt payload. The user's real workflow is
# still a draft - this targets generic, common node types (CLIPTextEncode
# for the positive prompt, LoadImage per reference, KSampler.seed) so the
# rest of the generation pipeline (comfy.py) can be built and tested against
# *a* workflow shape now, without waiting on the real one. Once the real
# workflow JSON is ready: replace PLACEHOLDER_WORKFLOW below (or point the
# loader at the real file) and fix the node-ID lookups in
# build_workflow_payload to match its actual node IDs - this file is
# deliberately the only place those IDs are hardcoded.
import copy

# Node IDs below ("6" for the positive prompt, "3" for KSampler) are
# ComfyUI's typical default IDs for a basic txt2img/txt2vid-style graph -
# NOT guaranteed to match the user's real workflow once it exists.
PLACEHOLDER_WORKFLOW: dict = {
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "", "clip": ["4", 1]},
    },
    "3": {
        "class_type": "KSampler",
        "inputs": {"seed": 0},
    },
}


def build_workflow_payload(prompt_text: str, reference_filenames: list[str], seed: int) -> dict:
    """Returns the template with prompt/seed/reference images substituted
    in. `seed` is the already-resolved value (the caller picks a random one
    if none was given) so this function only ever deals with a concrete int.
    """
    workflow = copy.deepcopy(PLACEHOLDER_WORKFLOW)

    if "6" in workflow:
        workflow["6"]["inputs"]["text"] = prompt_text

    if "3" in workflow:
        workflow["3"]["inputs"]["seed"] = seed

    # One LoadImage node per reference, node IDs "ref0", "ref1", ... - the
    # placeholder graph doesn't wire these into anything downstream since
    # there's nothing to wire them to yet; once the real workflow exists,
    # point its own reference-image inputs at these instead.
    for index, filename in enumerate(reference_filenames):
        workflow[f"ref{index}"] = {
            "class_type": "LoadImage",
            "inputs": {"image": filename},
        }

    return workflow
