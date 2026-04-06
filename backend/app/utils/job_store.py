"""
Thread-safe, TTL-bounded in-memory job store.

Used by floorplan and optimize endpoints to store background job state.
Evicts completed/failed jobs after JOB_TTL_SECONDS to prevent unbounded
memory growth. Running/pending jobs are never evicted.
"""

import threading
import time
import logging
from typing import TypeVar, Generic

from pydantic import BaseModel

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Completed/failed jobs are kept for 30 minutes, then evicted.
JOB_TTL_SECONDS = 30 * 60

# Hard cap: never store more than this many jobs total (including running).
# If hit, oldest completed jobs are evicted first.
MAX_JOBS = 500

# How often we run the eviction sweep (at most once per this interval).
_EVICT_INTERVAL_SECONDS = 60


class JobStore(Generic[T]):
    """Thread-safe job store with TTL eviction for Pydantic models."""

    def __init__(self, name: str = "jobs"):
        self._name = name
        self._jobs: dict[str, T] = {}
        self._timestamps: dict[str, float] = {}  # job_id → time when terminal state reached
        self._lock = threading.Lock()
        self._last_eviction = 0.0

    @property
    def lock(self) -> threading.Lock:
        """Expose lock for callers that need atomic create-and-store."""
        return self._lock

    def put(self, job_id: str, job: T) -> None:
        """Store a new job."""
        with self._lock:
            self._jobs[job_id] = job
            # No terminal timestamp yet — running jobs aren't evicted
        self._maybe_evict()

    def get(self, job_id: str) -> T | None:
        """Thread-safe read: return a deep copy of job state, or None."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return job.model_copy(deep=True)

    def update(self, job_id: str, **kwargs) -> None:
        """Thread-safe write: update specific fields on a job."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in kwargs.items():
                setattr(job, key, value)
            # Track when job reaches a terminal state
            status = kwargs.get("status")
            if status in ("completed", "failed"):
                self._timestamps[job_id] = time.monotonic()

    def append_to_list(self, job_id: str, field: str, item) -> None:
        """Thread-safe append to a list field on a job."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                getattr(job, field).append(item)

    def _maybe_evict(self) -> None:
        """Run eviction if enough time has passed since the last sweep."""
        now = time.monotonic()
        if now - self._last_eviction < _EVICT_INTERVAL_SECONDS:
            return
        with self._lock:
            self._evict_locked(now)

    def _evict_locked(self, now: float) -> None:
        """Evict expired terminal jobs. Must be called with lock held."""
        self._last_eviction = now
        expired = []

        # 1. TTL eviction: remove completed/failed jobs older than JOB_TTL_SECONDS
        for job_id, finished_at in list(self._timestamps.items()):
            if now - finished_at > JOB_TTL_SECONDS:
                expired.append(job_id)

        # 2. Hard cap eviction: if still over MAX_JOBS, remove oldest terminal jobs
        total_after_ttl = len(self._jobs) - len(expired)
        if total_after_ttl > MAX_JOBS:
            # Sort terminal jobs by age (oldest first), evict enough to get under cap
            remaining_terminal = [
                (jid, ts) for jid, ts in self._timestamps.items()
                if jid not in expired
            ]
            remaining_terminal.sort(key=lambda x: x[1])
            overshoot = total_after_ttl - MAX_JOBS
            for jid, _ in remaining_terminal[:overshoot]:
                expired.append(jid)

        # Perform eviction
        for job_id in expired:
            self._jobs.pop(job_id, None)
            self._timestamps.pop(job_id, None)

        if expired:
            logger.info(f"[{self._name}] Evicted {len(expired)} expired jobs, {len(self._jobs)} remaining")
