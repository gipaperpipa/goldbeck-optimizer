from pydantic import BaseModel, Field, model_validator


class CoordinatePoint(BaseModel):
    # M8/M10: Validate WGS84 coordinate ranges
    lng: float = Field(ge=-180, le=180, description="Longitude (WGS84)")
    lat: float = Field(ge=-90, le=90, description="Latitude (WGS84)")


class PlotInput(BaseModel):
    mode: str  # "coordinates" or "address"
    boundary_polygon: list[CoordinatePoint] | None = None
    address: str | None = None
    width_m: float | None = Field(default=None, gt=0, le=1000, description="Plot width in meters")
    depth_m: float | None = Field(default=None, gt=0, le=1000, description="Plot depth in meters")
    vertices_m: list[tuple[float, float]] | None = None

    @model_validator(mode="after")
    def validate_polygon(self) -> "PlotInput":
        """M8: Validate GeoJSON polygon has at least 3 points."""
        if self.boundary_polygon is not None and len(self.boundary_polygon) < 3:
            raise ValueError("Polygon must have at least 3 vertices")
        return self


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
