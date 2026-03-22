from pydantic import BaseModel


class CoordinatePoint(BaseModel):
    lng: float
    lat: float


class PlotInput(BaseModel):
    mode: str  # "coordinates" or "address"
    boundary_polygon: list[CoordinatePoint] | None = None
    address: str | None = None
    width_m: float | None = None
    depth_m: float | None = None
    vertices_m: list[tuple[float, float]] | None = None


class PlotAnalysis(BaseModel):
    area_sqm: float
    area_acres: float
    perimeter_m: float
    width_m: float
    depth_m: float
    boundary_polygon_local: list[tuple[float, float]]
    boundary_polygon_geo: list[CoordinatePoint]
    centroid_geo: CoordinatePoint
    address_resolved: str | None = None
    zoning_hint: str | None = None
