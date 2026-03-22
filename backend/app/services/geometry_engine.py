import math

import numpy as np
from shapely.geometry import Polygon, MultiPolygon, box
from shapely.affinity import rotate, translate
from shapely import ops
from pyproj import Transformer

from app.models.plot import PlotAnalysis, CoordinatePoint


class GeometryEngine:
    """Shapely-based spatial operations for plot analysis and building layout."""

    def __init__(self):
        self._m_per_deg_lat = 110_947.0  # approximate at mid-latitudes (364000 ft ≈ 110947 m)
        self._m_per_deg_lng = 87_843.0   # (288200 ft ≈ 87843 m)

    # ── Plot Analysis ──────────────────────────────────────────

    def analyze_rectangular_plot(
        self,
        width_m: float,
        depth_m: float,
        centroid_lng: float,
        centroid_lat: float,
    ) -> PlotAnalysis:
        hw, hd = width_m / 2, depth_m / 2
        local_verts = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
        polygon = Polygon(local_verts)
        geo_verts = self._local_to_geo(local_verts, centroid_lng, centroid_lat)

        return PlotAnalysis(
            area_sqm=polygon.area,
            area_acres=polygon.area / 4046.86,  # 1 acre = 4046.86 sqm
            perimeter_m=polygon.length,
            width_m=width_m,
            depth_m=depth_m,
            boundary_polygon_local=local_verts,
            boundary_polygon_geo=[CoordinatePoint(lng=v[0], lat=v[1]) for v in geo_verts],
            centroid_geo=CoordinatePoint(lng=centroid_lng, lat=centroid_lat),
        )

    def analyze_from_local_vertices(
        self,
        vertices: list[tuple[float, float]],
        centroid_lng: float,
        centroid_lat: float,
    ) -> PlotAnalysis:
        polygon = Polygon(vertices)
        bounds = polygon.bounds
        width_m = bounds[2] - bounds[0]
        depth_m = bounds[3] - bounds[1]
        geo_verts = self._local_to_geo(vertices, centroid_lng, centroid_lat)

        return PlotAnalysis(
            area_sqm=polygon.area,
            area_acres=polygon.area / 4046.86,  # 1 acre = 4046.86 sqm
            perimeter_m=polygon.length,
            width_m=width_m,
            depth_m=depth_m,
            boundary_polygon_local=list(vertices),
            boundary_polygon_geo=[CoordinatePoint(lng=v[0], lat=v[1]) for v in geo_verts],
            centroid_geo=CoordinatePoint(lng=centroid_lng, lat=centroid_lat),
        )

    def analyze_from_geo_coordinates(
        self, coords: list[tuple[float, float]]
    ) -> PlotAnalysis:
        """Analyze from geographic coordinates (lng, lat)."""
        if len(coords) < 3:
            raise ValueError("Need at least 3 coordinates to form a polygon")

        centroid_lng = sum(c[0] for c in coords) / len(coords)
        centroid_lat = sum(c[1] for c in coords) / len(coords)

        m_per_deg_lng = self._m_per_deg_lat * math.cos(math.radians(centroid_lat))
        local_verts = []
        for lng, lat in coords:
            x = (lng - centroid_lng) * m_per_deg_lng
            y = (lat - centroid_lat) * self._m_per_deg_lat
            local_verts.append((x, y))

        polygon = Polygon(local_verts)
        bounds = polygon.bounds

        return PlotAnalysis(
            area_sqm=polygon.area,
            area_acres=polygon.area / 4046.86,  # 1 acre = 4046.86 sqm
            perimeter_m=polygon.length,
            width_m=bounds[2] - bounds[0],
            depth_m=bounds[3] - bounds[1],
            boundary_polygon_local=local_verts,
            boundary_polygon_geo=[CoordinatePoint(lng=c[0], lat=c[1]) for c in coords],
            centroid_geo=CoordinatePoint(lng=centroid_lng, lat=centroid_lat),
        )

    # ── Buildable Area ─────────────────────────────────────────

    def compute_buildable_area(
        self,
        boundary: list[tuple[float, float]],
        front_m: float,
        rear_m: float,
        side_left_m: float,
        side_right_m: float,
    ) -> Polygon | None:
        """
        Compute buildable area by applying setbacks.
        Uses a simplified approach: buffer the polygon inward by the average setback,
        then refine with directional offsets.
        """
        plot = Polygon(boundary)
        if not plot.is_valid:
            plot = plot.buffer(0)

        bounds = plot.bounds
        min_x, min_y, max_x, max_y = bounds

        setback_box = box(
            min_x + side_left_m,
            min_y + front_m,
            max_x - side_right_m,
            max_y - rear_m,
        )

        buildable = plot.intersection(setback_box)
        if buildable.is_empty:
            return None
        if isinstance(buildable, MultiPolygon):
            buildable = max(buildable.geoms, key=lambda g: g.area)
        return buildable

    # ── Building Operations ────────────────────────────────────

    def create_building_polygon(
        self,
        x: float,
        y: float,
        width: float,
        depth: float,
        rotation_deg: float = 0.0,
    ) -> Polygon:
        hw, hd = width / 2, depth / 2
        bldg = box(-hw, -hd, hw, hd)
        if rotation_deg != 0:
            bldg = rotate(bldg, rotation_deg, origin=(0, 0))
        bldg = translate(bldg, xoff=x, yoff=y)
        return bldg

    def check_overlap(self, poly_a: Polygon, poly_b: Polygon) -> bool:
        return poly_a.intersects(poly_b) and poly_a.intersection(poly_b).area > 0.1

    def fits_within(self, building: Polygon, buildable_area: Polygon) -> bool:
        return buildable_area.contains(building)

    def compute_lot_coverage(
        self, buildings: list[Polygon], plot_area: float
    ) -> float:
        if not buildings:
            return 0.0
        total = ops.unary_union(buildings).area
        return (total / plot_area) * 100.0

    def compute_far(
        self,
        buildings: list[dict],
        plot_area: float,
    ) -> float:
        """buildings is list of dicts with 'footprint_area' and 'stories' keys."""
        total_floor_area = sum(b["footprint_area"] * b["stories"] for b in buildings)
        return total_floor_area / plot_area if plot_area > 0 else 0.0

    def compute_building_separation(
        self, poly_a: Polygon, poly_b: Polygon
    ) -> float:
        return poly_a.distance(poly_b)

    def compute_open_space_pct(
        self, buildings: list[Polygon], plot_boundary: Polygon
    ) -> float:
        if not buildings:
            return 100.0
        built_union = ops.unary_union(buildings)
        open_area = plot_boundary.area - built_union.area
        return (open_area / plot_boundary.area) * 100.0

    # ── Helpers ────────────────────────────────────────────────

    def _local_to_geo(
        self,
        local_verts: list[tuple[float, float]],
        centroid_lng: float,
        centroid_lat: float,
    ) -> list[tuple[float, float]]:
        m_per_deg_lng = self._m_per_deg_lat * math.cos(math.radians(centroid_lat))
        result = []
        for x, y in local_verts:
            lng = centroid_lng + x / m_per_deg_lng
            lat = centroid_lat + y / self._m_per_deg_lat
            result.append((lng, lat))
        return result
