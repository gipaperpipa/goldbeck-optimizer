"""
Tests for the async token-bucket rate limiter.

Verifies: burst allowance, throttling after burst, unconfigured services
pass through, and concurrent access safety.
"""
import asyncio
import time

import pytest

from app.utils.rate_limiter import RateLimiter


@pytest.fixture
def limiter():
    rl = RateLimiter()
    rl.configure("fast", requests_per_second=10.0, burst=3)
    rl.configure("slow", requests_per_second=1.0, burst=1)
    return rl


# ── Basic behavior ────────────────────────────────────────────────────

class TestRateLimiterBasic:
    @pytest.mark.asyncio
    async def test_burst_allowed_immediately(self, limiter):
        """First `burst` requests should not block."""
        start = time.monotonic()
        for _ in range(3):
            await limiter.acquire("fast")
        elapsed = time.monotonic() - start
        assert elapsed < 0.1, f"Burst requests should be instant, took {elapsed:.2f}s"

    @pytest.mark.asyncio
    async def test_throttled_after_burst(self, limiter):
        """The (burst+1)th request should wait ~1/rate seconds."""
        # Exhaust burst
        for _ in range(3):
            await limiter.acquire("fast")
        # Next request should be throttled
        start = time.monotonic()
        await limiter.acquire("fast")
        elapsed = time.monotonic() - start
        assert elapsed >= 0.05, f"Should have been throttled, took only {elapsed:.3f}s"

    @pytest.mark.asyncio
    async def test_unconfigured_service_passes_through(self, limiter):
        """Acquiring an unconfigured service should return instantly."""
        start = time.monotonic()
        for _ in range(100):
            await limiter.acquire("unknown_service")
        elapsed = time.monotonic() - start
        assert elapsed < 0.1

    @pytest.mark.asyncio
    async def test_slow_service_enforces_rate(self, limiter):
        """1 req/s service: 2nd request should wait ~1 second."""
        await limiter.acquire("slow")  # use the burst token
        start = time.monotonic()
        await limiter.acquire("slow")
        elapsed = time.monotonic() - start
        assert elapsed >= 0.8, f"Should wait ~1s, took {elapsed:.2f}s"

    @pytest.mark.asyncio
    async def test_tokens_refill_over_time(self, limiter):
        """After waiting, tokens should refill."""
        # Exhaust burst
        for _ in range(3):
            await limiter.acquire("fast")
        # Wait for tokens to refill (3 tokens at 10/s = 0.3s)
        await asyncio.sleep(0.4)
        # Should be able to burst again
        start = time.monotonic()
        for _ in range(3):
            await limiter.acquire("fast")
        elapsed = time.monotonic() - start
        assert elapsed < 0.15, f"Refilled tokens should allow burst, took {elapsed:.2f}s"


# ── Concurrent access ─────────────────────────────────────────────────

class TestRateLimiterConcurrency:
    @pytest.mark.asyncio
    async def test_concurrent_acquires_dont_exceed_rate(self, limiter):
        """Multiple coroutines acquiring simultaneously should still be rate-limited."""
        timestamps = []

        async def worker():
            await limiter.acquire("slow")
            timestamps.append(time.monotonic())

        # Launch 3 concurrent workers on a 1 req/s limiter with burst=1
        tasks = [asyncio.create_task(worker()) for _ in range(3)]
        await asyncio.gather(*tasks)

        # The 3 requests should be spread over ~2 seconds
        total_time = timestamps[-1] - timestamps[0]
        assert total_time >= 1.5, f"3 requests at 1/s should take ≥1.5s, took {total_time:.2f}s"


# ── Singleton configuration ───────────────────────────────────────────

class TestRateLimiterSingleton:
    def test_default_services_configured(self):
        """The module-level singleton should have all 4 services."""
        from app.utils.rate_limiter import rate_limiter
        assert "nominatim" in rate_limiter._buckets
        assert "overpass" in rate_limiter._buckets
        assert "wfs" in rate_limiter._buckets
        assert "bkg" in rate_limiter._buckets
