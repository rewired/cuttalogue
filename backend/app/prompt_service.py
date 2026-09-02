"""Transport-neutral access to CUTTAlogue's canonical H3 prompt compiler."""
import json
import shutil
import subprocess
from pathlib import Path


BRIDGE = Path(__file__).with_name("h3_prompt_bridge.js")


class PromptCompilationError(RuntimeError):
    pass


def compile_shot_prompt(shot: dict) -> dict:
    node = shutil.which("node")
    if not node:
        raise PromptCompilationError("Node.js is required to run the canonical H3 prompt compiler")
    try:
        completed = subprocess.run(
            [node, str(BRIDGE)],
            input=json.dumps({"shot": shot}, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PromptCompilationError("H3 prompt compiler could not be started") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown compiler error"
        raise PromptCompilationError(f"H3 prompt compilation failed: {detail}")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PromptCompilationError("H3 prompt compiler returned invalid JSON") from error
    if not isinstance(result, dict) or not isinstance(result.get("prompt"), str):
        raise PromptCompilationError("H3 prompt compiler returned an invalid result")
    return result
