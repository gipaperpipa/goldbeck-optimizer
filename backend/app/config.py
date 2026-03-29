import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Land Layout Optimizer API"
    debug: bool = True
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
