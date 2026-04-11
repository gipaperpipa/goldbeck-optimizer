"""
Tests for the thread-safe, TTL-bounded JobStore.

Covers: thread safety, TTL eviction, hard cap eviction, deep copy on read,
terminal state tracking, append_to_list, and edge cases.
"""
import threading
import time
from unittest.mock import patch

import pytest
from pydantic import BaseModel

from app.utils.job_store import JobStore, JOB_TTL_SECONDS, MAX_JOBS, _EVICT_INTERVAL_SECONDS


# ── Test model ───────────────────────────────────────────────────────

class DummyJob(BaseModel):
    status: str = "pending"
    value: int = 0
    items: list[str] = []


# ── Basic CRUD ────────────────────────────────────────────────────────

class TestJobStoreBasic:
    def test_put_and_get(self):
        store = JobStore[DummyJob](name="test")
        job = DummyJob(value=42)
        store.put("j1", job)
        result = store.get("j1")
        assert result is not None
        assert result.value == 42

    def test_get_missing_returns_none(self):
        store = JobStore[DummyJob](name="test")
        assert store.get("nonexistent") is None

    def test_get_returns_deep_copy(self):
        """Mutating the returned object must NOT affect the stored copy."""
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob(items=["a"]))
        copy = store.get("j1")
        copy.items.append("MUTATED")
        original = store.get("j1")
        assert original.items == ["a"], "Store returned a shallow reference, not a deep copy"

    def test_update_fields(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.update("j1", status="running", value=10)
        job = store.get("j1")
        assert job.status == "running"
        assert job.value == 10

    def test_update_nonexistent_is_noop(self):
        store = JobStore[DummyJob](name="test")
        store.update("missing", status="failed")  # should not raise

    def test_append_to_list(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.append_to_list("j1", "items", "hello")
        store.append_to_list("j1", "items", "world")
        job = store.get("j1")
        assert job.items == ["hello", "world"]

    def test_append_to_list_nonexistent_is_noop(self):
        store = JobStore[DummyJob](name="test")
        store.append_to_list("missing", "items", "x")  # should not raise


# ── TTL eviction ──────────────────────────────────────────────────────

class TestJobStoreTTL:
    def test_completed_jobs_get_timestamp(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        assert "j1" not in store._timestamps
        store.update("j1", status="completed")
        assert "j1" in store._timestamps

    def test_failed_jobs_get_timestamp(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.update("j1", status="failed")
        assert "j1" in store._timestamps

    def test_running_jobs_not_timestamped(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.update("j1", status="running")
        assert "j1" not in store._timestamps

    def test_ttl_eviction_removes_old_terminal_jobs(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.update("j1", status="completed")

        # Simulate time passing beyond TTL
        old_time = time.monotonic() - JOB_TTL_SECONDS - 10
        store._timestamps["j1"] = old_time
        store._last_eviction = 0  # force eviction to run

        # Trigger eviction
        store._maybe_evict()

        assert store.get("j1") is None, "Completed job should be evicted after TTL"

    def test_ttl_eviction_keeps_fresh_terminal_jobs(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.update("j1", status="completed")
        store._last_eviction = 0  # force eviction to run

        store._maybe_evict()

        assert store.get("j1") is not None, "Fresh completed job should NOT be evicted"

    def test_running_jobs_never_evicted(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        store.update("j1", status="running")
        store._last_eviction = 0

        store._maybe_evict()

        assert store.get("j1") is not None, "Running jobs must never be evicted"


# ── Hard cap eviction ─────────────────────────────────────────────────

class TestJobStoreHardCap:
    def test_hard_cap_evicts_oldest_terminal_jobs(self):
        store = JobStore[DummyJob](name="test")
        store._last_eviction = 0  # allow eviction

        # Fill beyond MAX_JOBS with terminal jobs
        now = time.monotonic()
        for i in range(MAX_JOBS + 10):
            jid = f"j{i:04d}"
            store._jobs[jid] = DummyJob(status="completed", value=i)
            store._timestamps[jid] = now - (MAX_JOBS + 10 - i)  # oldest first

        # Manually trigger eviction
        store._evict_locked(time.monotonic())

        remaining = len(store._jobs)
        assert remaining <= MAX_JOBS, f"Expected ≤{MAX_JOBS} jobs, got {remaining}"

    def test_hard_cap_prefers_evicting_terminal_over_running(self):
        store = JobStore[DummyJob](name="test")
        store._last_eviction = 0

        # Add running jobs (should not be evicted)
        for i in range(10):
            store._jobs[f"running-{i}"] = DummyJob(status="running")

        # Add terminal jobs to exceed cap
        now = time.monotonic()
        for i in range(MAX_JOBS + 5):
            jid = f"terminal-{i}"
            store._jobs[jid] = DummyJob(status="completed")
            store._timestamps[jid] = now - i

        store._evict_locked(time.monotonic())

        # All running jobs should survive
        for i in range(10):
            assert f"running-{i}" in store._jobs, f"Running job running-{i} was incorrectly evicted"


# ── Thread safety ─────────────────────────────────────────────────────

class TestJobStoreThreadSafety:
    def test_concurrent_put_and_get(self):
        """Multiple threads writing and reading should not corrupt state."""
        store = JobStore[DummyJob](name="test")
        errors = []
        n_threads = 20
        n_ops = 50

        def worker(thread_id):
            try:
                for i in range(n_ops):
                    jid = f"t{thread_id}-{i}"
                    store.put(jid, DummyJob(value=thread_id * 1000 + i))
                    result = store.get(jid)
                    if result is None:
                        errors.append(f"Job {jid} disappeared immediately after put")
                    elif result.value != thread_id * 1000 + i:
                        errors.append(f"Job {jid} has wrong value: {result.value}")
            except Exception as e:
                errors.append(f"Thread {thread_id} exception: {e}")

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not errors, f"Thread safety violations:\n" + "\n".join(errors[:5])
        assert len(store._jobs) == n_threads * n_ops

    def test_concurrent_update(self):
        """Multiple threads updating the same job should not lose writes."""
        store = JobStore[DummyJob](name="test")
        store.put("shared", DummyJob(value=0))
        n_threads = 10
        n_increments = 100

        def incrementer():
            for _ in range(n_increments):
                with store.lock:
                    job = store._jobs.get("shared")
                    if job:
                        job.value += 1

        threads = [threading.Thread(target=incrementer) for _ in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        result = store.get("shared")
        assert result.value == n_threads * n_increments

    def test_concurrent_append_to_list(self):
        store = JobStore[DummyJob](name="test")
        store.put("j1", DummyJob())
        n_threads = 10
        n_appends = 50

        def appender(tid):
            for i in range(n_appends):
                store.append_to_list("j1", "items", f"t{tid}-{i}")

        threads = [threading.Thread(target=appender, args=(t,)) for t in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        result = store.get("j1")
        assert len(result.items) == n_threads * n_appends
