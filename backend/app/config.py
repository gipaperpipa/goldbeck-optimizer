import logging
import os
import sys

from pydantic_settings import BaseSettings


def configure_logging(debug: bool = True) -> None:
    """Set up structured logging for the application.

    In production (debug=False), logs are JSON-formatted for easy ingestion
    by log aggregators (Datadog, CloudWatch, etc.).
    In development (debug=True), logs use a human-readable format.
    """
    level = logging.DEBUG if debug else logging.INFO
    fmt = (
        "%(asctime)s %(levelname)s %(name)s %(message)s"
        if debug
        else '{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}'
    )
    logging.basicConfig(
        level=level,
        format=fmt,
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stdout,
        force=True,
    )


class Settings(BaseSettings):
    app_name: str = "Land Layout Optimizer API"
    debug: bool = os.environ.get("DEBUG", "false").lower() in ("1", "true", "yes")
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ]
    mapbox_token: str = ""
    anthropic_api_key: str = ""

    class Config:
        env_file = ".env"

    def get_cors_origins(self) -> list[str]:
        """Return CORS origins including any set via FRONTEND_URL env var."""
        origins = list(self.cors_origins)
        frontend_url = os.environ.get("FRONTEND_URL", "")
        if frontend_url and frontend_url not in origins:
            origins.append(frontend_url)
            # Also allow the bare domain without trailing slash
            bare = frontend_url.rstrip("/")
            if bare not in origins:
                origins.append(bare)
        return origins


settings = Settings()
