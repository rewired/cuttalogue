# Regression coverage for a real bug found while investigating an observed
# "Expand with AI" hang (spinner/buttons stuck forever): jobs.py's
# GET /api/jobs/{id}/events generator blocked forever on job.queue.get() if
# a client (re)connected after the job had already reached a terminal state
# - e.g. the browser's EventSource auto-reconnecting after a dropped
# connection - because the sentinel that ends the queue was already
# consumed by whichever connection was open when the job actually finished,
# leaving a fresh connection's queue permanently empty. job_events now
# checks job.status first and synthesizes the terminal event directly from
# the job's own fields instead of relying on a queue with no history left to
# replay. This exercises the route function directly (it's a plain async
# def under the @router.get decorator, so no HTTP layer is needed) with a
# short asyncio.wait_for timeout guard so a regression fails the test
# instead of hanging the whole suite.
#
# Run with:
#   backend/.venv/Scripts/python.exe backend/tests/test_jobs_events.py
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import jobs  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


async def next_chunk(response, timeout: float):
    try:
        raw = await asyncio.wait_for(response.body_iterator.__anext__(), timeout=timeout)
    except asyncio.TimeoutError:
        return None
    return raw if isinstance(raw, str) else raw.decode()


async def main() -> None:
    # --- Case A: reconnecting to an already-'done' job must not hang -------
    job_done = jobs.create_job()
    job_done.status = "done"
    job_done.result = {"text": "hello"}
    response_done = await jobs.job_events(job_done.id)
    chunk_done = await next_chunk(response_done, timeout=2)
    check(chunk_done is not None, "job_events: does not hang reconnecting to an already-done job")
    if chunk_done is not None:
        check('"status": "done"' in chunk_done, f"job_events: emits the terminal done event ({chunk_done!r})")
        check('"text": "hello"' in chunk_done, f"job_events: includes the job's own result ({chunk_done!r})")

    # --- Case B: same for an already-'error' job ----------------------------
    job_error = jobs.create_job()
    job_error.status = "error"
    job_error.error = "boom"
    response_error = await jobs.job_events(job_error.id)
    chunk_error = await next_chunk(response_error, timeout=2)
    check(chunk_error is not None, "job_events: does not hang reconnecting to an already-errored job")
    if chunk_error is not None:
        check(
            '"status": "error"' in chunk_error and '"message": "boom"' in chunk_error,
            f"job_events: emits the terminal error event with its message ({chunk_error!r})",
        )

    # --- Case C: same for an already-'cancelled' job ------------------------
    job_cancelled = jobs.create_job()
    job_cancelled.status = "cancelled"
    response_cancelled = await jobs.job_events(job_cancelled.id)
    chunk_cancelled = await next_chunk(response_cancelled, timeout=2)
    check(chunk_cancelled is not None, "job_events: does not hang reconnecting to an already-cancelled job")
    if chunk_cancelled is not None:
        check('"status": "cancelled"' in chunk_cancelled, f"job_events: emits the terminal cancelled event ({chunk_cancelled!r})")

    # --- Case D: a still-running job's stream is unaffected - it still -----
    # correctly blocks until a real event is pushed (no regression to the
    # normal, non-reconnect case). Uses asyncio.wait (not wait_for) so the
    # pending __anext__() task is never cancelled while suspended inside the
    # generator - cancelling it there would corrupt the generator itself,
    # which is a test-harness pitfall unrelated to the fix under test.
    job_running = jobs.create_job()
    job_running.status = "running"
    response_running = await jobs.job_events(job_running.id)
    pending_next = asyncio.ensure_future(response_running.body_iterator.__anext__())
    done_early, _pending = await asyncio.wait({pending_next}, timeout=0.3)
    check(pending_next not in done_early, "job_events: a still-running job's stream still blocks until an event is pushed")
    await jobs.emit(job_running, {"status": "done", "result": {"ok": True}})
    raw_live = await asyncio.wait_for(pending_next, timeout=2)
    live_chunk = raw_live if isinstance(raw_live, str) else raw_live.decode()
    check('"status": "done"' in live_chunk, f"job_events: still delivers a live-pushed event normally ({live_chunk!r})")


asyncio.run(main())

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nAll job-events (SSE reconnect / terminal-state) checks passed.")
