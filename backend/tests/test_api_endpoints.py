"""
Tests for API endpoints using FastAPI's TestClient.

Covers: floorplan POST/GET, validation endpoint, estimate endpoint,
health check, and error responses.

Requires: pip install httpx  (for TestClient async support)
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


# ── Health check ──────────────────────────────────────────────────────

class TestHealthCheck:
    def test_health_returns_ok(self):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"


# ── Floor plan endpoints ──────────────────────────────────────────────

class TestFloorPlanAPI:
    """Minimal request that triggers the optimizer with 1 generation."""

    MINIMAL_REQUEST = {
        "building_id": "test-001",
        "building_width_m": 25.0,
        "building_depth_m": 12.5,
        "stories": 3,
        "generations": 1,
        "population_size": 2,
    }

    def test_post_floorplan_returns_job(self):
        resp = client.post("/api/v1/floorplan", json=self.MINIMAL_REQUEST)
        assert resp.status_code == 200
        data = resp.json()
        assert "job_id" in data
        assert data["status"] == "pending"
        assert data["total_generations"] == 1

    def test_get_floorplan_nonexistent_returns_404(self):
        resp = client.get("/api/v1/floorplan/nonexistent-job-id")
        assert resp.status_code == 404

    def test_post_floorplan_invalid_generations(self):
        """Pydantic validation should reject generations=0."""
        bad = {**self.MINIMAL_REQUEST, "generations": 0}
        resp = client.post("/api/v1/floorplan", json=bad)
        assert resp.status_code == 422

    def test_post_floorplan_invalid_population(self):
        """Pydantic validation should reject population_size=0."""
        bad = {**self.MINIMAL_REQUEST, "population_size": 0}
        resp = client.post("/api/v1/floorplan", json=bad)
        assert resp.status_code == 422

    def test_post_floorplan_excessive_generations(self):
        """Pydantic validation should reject generations > 500."""
        bad = {**self.MINIMAL_REQUEST, "generations": 999}
        resp = client.post("/api/v1/floorplan", json=bad)
        assert resp.status_code == 422

    def test_post_and_poll_until_done(self):
        """Start a 1-gen job and poll until completed or failed."""
        import time

        resp = client.post("/api/v1/floorplan", json=self.MINIMAL_REQUEST)
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]

        # Poll for up to 30 seconds
        for _ in range(60):
            poll = client.get(f"/api/v1/floorplan/{job_id}")
            assert poll.status_code == 200
            data = poll.json()
            if data["status"] in ("completed", "failed"):
                break
            time.sleep(0.5)
        else:
            pytest.fail(f"Job {job_id} did not complete within 30 seconds")

        # Verify completed job has variants
        if data["status"] == "completed":
            assert len(data["variants"]) > 0
            assert data["building_floor_plans"] is not None
            assert data["progress_pct"] == 100.0


# ── Estimate endpoint ─────────────────────────────────────────────────

class TestEstimateEndpoint:
    def test_estimate_returns_values(self):
        resp = client.post("/api/v1/floorplan/estimate", json={
            "building_id": "test",
            "building_width_m": 25.0,
            "building_depth_m": 12.5,
            "stories": 3,
            "generations": 10,
            "population_size": 20,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_evaluations"] == 200
        assert data["estimated_seconds"] > 0


# ── Security headers ──────────────────────────────────────────────────

class TestSecurityHeaders:
    def test_version_header(self):
        resp = client.get("/api/health")
        assert resp.headers.get("X-API-Version") == "1.0"

    def test_security_headers_present(self):
        resp = client.get("/api/health")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"
        assert resp.headers.get("X-Frame-Options") == "DENY"
        assert "strict-origin" in resp.headers.get("Referrer-Policy", "")


# ── Request size limit ────────────────────────────────────────────────

class TestRequestSizeLimit:
    def test_oversized_request_rejected(self):
        """Requests over 10 MB should be rejected."""
        # Send a payload that's > 10 MB
        huge = {"data": "x" * (11 * 1024 * 1024)}
        resp = client.post("/api/v1/floorplan", json=huge)
        # Should get 413 or 422 (payload too large or validation error)
        assert resp.status_code in (413, 422)
