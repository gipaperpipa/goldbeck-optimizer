"""
Async rate limiter for external API calls.

Uses a token-bucket algorithm: each named service gets its own bucket
with a configurable requests-per-second rate. Callers `await` the
limiter before making an HTTP request — if the bucket is empty, they
block until a token becomes available.
"""

import asyncio
import time
import logging

logger = logging.getLogger(__name__)


class RateLimiter:
    """Per-service async token-bucket rate limiter."""

    def __init__(self):
        self._buckets: dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()

    def configure(self, service: str, requests_per_second: float, burst: int = 1):
        """
        Configure rate limit for a named service.

        Args:
            service: Identifier (e.g. "nominatim", "overpass", "wfs")
            requests_per_second: Sustained rate limit
            burst: Max requests allowed in a burst before throttling
        """
        self._buckets[service] = _Bucket(requests_per_second, burst)

    async def acquire(self, service: str):
        """
        Wait until a request to `service` is allowed.
        If service has no configured limit, returns immediately.
        """
        bucket = self._buckets.get(service)
        if bucket is None:
            return
        await bucket.acquire()


class _Bucket:
    """Single token bucket for one service."""

    def __init__(self, rate: float, burst: int):
        self._rate = rate              # tokens per second
        self._burst = burst            # max tokens
        self._tokens = float(burst)    # start full
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._tokens = min(self._burst, self._tokens + elapsed * self._rate)
            self._last_refill = now

            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return

            # Wait for a token to become available
            wait_time = (1.0 - self._tokens) / self._rate
            logger.debug(f"Rate limit: waiting {wait_time:.2f}s for token")
            await asyncio.sleep(wait_time)
            self._tokens = 0.0
            self._last_refill = time.monotonic()


# ── Singleton with pre-configured services ────────────────────────────

rate_limiter = RateLimiter()

# Nominatim: max 1 req/sec (strict policy, will ban at higher rates)
rate_limiter.configure("nominatim", requests_per_second=1.0, burst=1)

# Overpass API: ~2 req/sec is safe for shared instances
rate_limiter.configure("overpass", requests_per_second=2.0, burst=2)

# German state WFS/WMS: conservative 3 req/sec (varies by state)
rate_limiter.configure("wfs", requests_per_second=3.0, burst=3)

# BKG federal service: 2 req/sec
rate_limiter.configure("bkg", requests_per_second=2.0, burst=2)
