# FPS / H3 frame-rule math - a direct Python port of js/frameMath.js. Kept in
# sync deliberately: the backend must recompute the render duration itself
# rather than trust a client-supplied number, since that duration drives the
# ffmpeg -t argument for lip-sync export.
import math


def fps(video: dict) -> float:
    return video["fpsNumerator"] / video["fpsDenominator"]


def desired_frames(duration_seconds: float, fps_value: float) -> int:
    return max(1, math.ceil(duration_seconds * fps_value))


def render_frames_for(desired: int, stride: int | None) -> int:
    if not stride:
        return desired
    return math.ceil((desired - 1) / stride) * stride + 1


def frame_calc(duration_seconds: float, video: dict) -> dict:
    fps_value = fps(video)
    cut_frames = desired_frames(duration_seconds, fps_value)
    stride = (video.get("frameRule") or {}).get("stride")
    render_frames = render_frames_for(cut_frames, stride)
    overhang_frames = render_frames - cut_frames
    overhang_seconds = overhang_frames / fps_value if fps_value else 0
    return {
        "cutFrames": cut_frames,
        "renderFrames": render_frames,
        "overhangFrames": overhang_frames,
        "overhangSeconds": overhang_seconds,
    }


def frame_rule_label(stride: int | None) -> str:
    if stride == 4:
        return "4n+1"
    if stride == 8:
        return "8n+1"
    return "free"


# MiniMax H3's own frame-count grid - fixed to the model itself (see upstream
# comfy_extras/nodes_minimax_h3.py: FPS=24, align_frame_count() requires
# n % 17 == 5), not the project's configurable frameRule/fps above. A project
# can run at any timeline fps; H3 always generates at 24fps internally
# regardless, so this must never read video.fpsNumerator/frameRule.
H3_FPS = 24
H3_STRIDE = 17
H3_REMAINDER = 5
H3_MIN_FRAMES = 5


def h3_frame_count(duration_seconds: float) -> int:
    # A requested duration is a lower bound: never choose a legal H3 frame
    # count that ends before the editorial cut. ``round`` was subtly wrong
    # whenever the requested duration sat just above an already-legal frame
    # count (for example 22.1 frames could round back to legal frame 22).
    desired = max(H3_MIN_FRAMES, math.ceil(duration_seconds * H3_FPS))
    return desired + (H3_REMAINDER - desired % H3_STRIDE) % H3_STRIDE
