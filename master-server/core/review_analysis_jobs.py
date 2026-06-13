from __future__ import annotations

import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from typing import Callable


_MAX_WORKERS = 1
_MAX_FINISHED_JOBS = 200
_TERMINAL_STATUSES = {"success", "error"}

_executor = ThreadPoolExecutor(max_workers=_MAX_WORKERS, thread_name_prefix="review-analysis")
_lock = threading.RLock()
_jobs: dict[str, dict] = {}
_futures: dict[str, Future] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _public_job(job: dict) -> dict:
    payload = deepcopy(job)
    payload.pop("_runner", None)
    return payload


def _prune_finished_locked() -> None:
    finished = [
        (job.get("updated_at") or job.get("created_at") or "", job_id)
        for job_id, job in _jobs.items()
        if job.get("status") in _TERMINAL_STATUSES
    ]
    if len(finished) <= _MAX_FINISHED_JOBS:
        return

    finished.sort()
    for _, job_id in finished[: len(finished) - _MAX_FINISHED_JOBS]:
        _jobs.pop(job_id, None)
        _futures.pop(job_id, None)


def create_analysis_job(
    *,
    kind: str,
    description: str,
    total: int = 1,
    runner: Callable[[str], dict],
    meta: dict | None = None,
) -> dict:
    job_id = uuid.uuid4().hex
    created_at = _now_iso()
    job = {
        "id": job_id,
        "job_id": job_id,
        "kind": str(kind or "review_analysis"),
        "description": str(description or ""),
        "status": "queued",
        "created_at": created_at,
        "updated_at": created_at,
        "started_at": None,
        "finished_at": None,
        "progress": {
            "done": 0,
            "total": max(0, int(total or 0)),
        },
        "summary": {},
        "result": None,
        "error": None,
        "meta": meta if isinstance(meta, dict) else {},
        "_runner": runner,
    }

    with _lock:
        _jobs[job_id] = job
        _prune_finished_locked()
        _futures[job_id] = _executor.submit(_run_job, job_id)
        return _public_job(job)


def _run_job(job_id: str) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        runner = job.get("_runner")
        job["status"] = "running"
        job["started_at"] = _now_iso()
        job["updated_at"] = job["started_at"]

    try:
        if not callable(runner):
            raise RuntimeError("analysis job runner is not callable")
        result = runner(job_id)
        with _lock:
            job = _jobs.get(job_id)
            if not job:
                return
            if isinstance(result, dict) and "result" in result:
                job["result"] = result.get("result")
                summary = result.get("summary")
                if isinstance(summary, dict):
                    job["summary"] = summary
                error = result.get("error")
                if error:
                    job["error"] = str(error)
                    job["status"] = "error"
            else:
                job["result"] = result
            if job.get("status") != "error":
                job["status"] = "success"
            finished_at = _now_iso()
            job["finished_at"] = finished_at
            job["updated_at"] = finished_at
            total = int(job.get("progress", {}).get("total") or 0)
            done = int(job.get("progress", {}).get("done") or 0)
            job["progress"] = {
                **(job.get("progress") if isinstance(job.get("progress"), dict) else {}),
                "done": max(done, total),
                "total": total,
            }
    except Exception as exc:
        with _lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "error"
            job["error"] = str(exc)
            finished_at = _now_iso()
            job["finished_at"] = finished_at
            job["updated_at"] = finished_at


def get_analysis_job(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(str(job_id or ""))
        return _public_job(job) if isinstance(job, dict) else None


def update_job_progress(
    job_id: str,
    *,
    done: int | None = None,
    total: int | None = None,
    current: dict | None = None,
    summary: dict | None = None,
) -> dict | None:
    with _lock:
        job = _jobs.get(str(job_id or ""))
        if not job:
            return None
        progress = dict(job.get("progress") if isinstance(job.get("progress"), dict) else {})
        if done is not None:
            progress["done"] = max(0, int(done))
        if total is not None:
            progress["total"] = max(0, int(total))
        if isinstance(current, dict):
            progress["current"] = current
        job["progress"] = progress
        if isinstance(summary, dict):
            job["summary"] = summary
        job["updated_at"] = _now_iso()
        return _public_job(job)


def wait_for_analysis_job(job_id: str, timeout: float | None = None) -> dict | None:
    future = None
    with _lock:
        future = _futures.get(str(job_id or ""))
    if future is not None:
        future.result(timeout=timeout)
    return get_analysis_job(job_id)


def reset_analysis_jobs_for_tests() -> None:
    with _lock:
        _jobs.clear()
        _futures.clear()
