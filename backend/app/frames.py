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
