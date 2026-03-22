from pydantic import BaseModel

from app.models.optimization import LayoutOption


class ShadowRequest(BaseModel):
    layout: LayoutOption
    latitude: float
    longitude: float
    date: str  # ISO date string e.g. "2025-06-21"
    times: list[str] = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"]


class ShadowSnapshot(BaseModel):
    time: str
    sun_azimuth_deg: float
    sun_altitude_deg: float
    shadow_polygons: list[list[tuple[float, float]]]
    direct_sunlight_pct: float


class ShadowResult(BaseModel):
    snapshots: list[ShadowSnapshot]
    avg_sunlight_pct: float
    worst_sunlight_pct: float
    best_sunlight_pct: float
