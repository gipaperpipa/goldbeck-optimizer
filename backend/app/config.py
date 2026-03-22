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


settings = Settings()
