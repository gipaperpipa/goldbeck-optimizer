import math
from datetime import datetime, timezone

from pysolar.solar import get_altitude, get_azimuth
from shapely.geometry import Polygon

from app.models.shadow import ShadowRequest, ShadowResult, ShadowSnapshot


class ShadowCalculator:
    def analyze(self, request: ShadowRequest) -> ShadowResult:
        snapshots: list[ShadowSnapshot] = []
        sunlight_values: list[float] = []

        date_parts = request.date.split("-")
        year, month, day = int(date_parts[0]), int(date_parts[1]), int(date_parts[2])

        for time_str in request.times:
            hour, minute = map(int, time_str.split(":"))
            dt = datetime(year, month, day, hour, minute, 0, tzinfo=timezone.utc)

            altitude = get_altitude(request.latitude, request.longitude, dt)
            azimuth = get_azimuth(request.latitude, request.longitude, dt)

            if altitude <= 0:
                snapshots.append(ShadowSnapshot(
                    time=time_str,
                    sun_azimuth_deg=azimuth,
                    sun_altitude_deg=altitude,
                    shadow_polygons=[],
                    direct_sunlight_pct=0.0,
                ))
                sunlight_values.append(0.0)
                continue

            shadow_polys = []
            for building in request.layout.buildings:
                shadow = self._compute_building_shadow(
                    x=building.position_x,
                    y=building.position_y,
                    width=building.width_m,
                    depth=building.depth_m,
                    height=building.total_height_m,
                    rotation_deg=building.rotation_deg,
                    sun_azimuth=azimuth,
                    sun_altitude=altitude,
                )
                if shadow:
                    shadow_polys.append(shadow)

            # Estimate sunlight percentage
            total_shadow_area = sum(
                Polygon(s).area if len(s) >= 3 else 0 for s in shadow_polys
            )
            plot_area = sum(
                b.width_m * b.depth_m for b in request.layout.buildings
            ) * 4  # approximate surrounding area
            sunlight_pct = max(0, 100 - (total_shadow_area / max(plot_area, 1)) * 100)

            snapshots.append(ShadowSnapshot(
                time=time_str,
                sun_azimuth_deg=azimuth,
                sun_altitude_deg=altitude,
                shadow_polygons=shadow_polys,
                direct_sunlight_pct=round(sunlight_pct, 1),
            ))
            sunlight_values.append(sunlight_pct)

        return ShadowResult(
            snapshots=snapshots,
            avg_sunlight_pct=round(
                sum(sunlight_values) / len(sunlight_values) if sunlight_values else 0, 1
            ),
            worst_sunlight_pct=round(min(sunlight_values) if sunlight_values else 0, 1),
            best_sunlight_pct=round(max(sunlight_values) if sunlight_values else 0, 1),
        )

    def _compute_building_shadow(
        self,
        x: float, y: float,
        width: float, depth: float, height: float,
        rotation_deg: float,
        sun_azimuth: float, sun_altitude: float,
    ) -> list[tuple[float, float]] | None:
        if sun_altitude <= 0:
            return None

        shadow_length = height / math.tan(math.radians(sun_altitude))
        az_rad = math.radians(sun_azimuth)

        # Shadow direction (opposite to sun direction)
        dx = -shadow_length * math.sin(az_rad)
        dy = -shadow_length * math.cos(az_rad)

        hw, hd = width / 2, depth / 2
        rot_rad = math.radians(rotation_deg)

        # Building corners
        corners = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
        rotated = []
        for cx, cy in corners:
            rx = cx * math.cos(rot_rad) - cy * math.sin(rot_rad) + x
            ry = cx * math.sin(rot_rad) + cy * math.cos(rot_rad) + y
            rotated.append((rx, ry))

        # Shadow polygon: building footprint + offset footprint
        shadow_corners = [(rx + dx, ry + dy) for rx, ry in rotated]

        # Convex hull of building + shadow
        all_points = rotated + shadow_corners
        try:
            from shapely.geometry import MultiPoint
            hull = MultiPoint(all_points).convex_hull
            if hull.geom_type == "Polygon":
                return list(hull.exterior.coords[:-1])
        except Exception:
            pass

        return shadow_corners
