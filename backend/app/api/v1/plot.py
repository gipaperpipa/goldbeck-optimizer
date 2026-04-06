import logging

from fastapi import APIRouter, HTTPException

from app.models.plot import PlotInput, PlotAnalysis
from app.services.geometry_engine import GeometryEngine
from app.services.geocoding import geocode_address

router = APIRouter()
logger = logging.getLogger(__name__)
geometry = GeometryEngine()

# Default fallback: Frankfurt am Main (central Germany)
_DEFAULT_CENTROID = {"lng": 8.6821, "lat": 50.1109}


@router.post("/analyze", response_model=PlotAnalysis)
async def analyze_plot(plot_input: PlotInput):
    try:
        if plot_input.mode == "coordinates" and plot_input.boundary_polygon:
            coords = [(p.lng, p.lat) for p in plot_input.boundary_polygon]
            analysis = geometry.analyze_from_geo_coordinates(coords)
            return analysis

        elif plot_input.mode == "address":
            geo_result = None
            if plot_input.address:
                geo_result = await geocode_address(plot_input.address)

            if not geo_result and plot_input.address:
                logger.warning(f"Geocoding failed for '{plot_input.address}', using Frankfurt default")

            if plot_input.width_m and plot_input.depth_m:
                centroid = geo_result if geo_result else _DEFAULT_CENTROID
                analysis = geometry.analyze_rectangular_plot(
                    width_m=plot_input.width_m,
                    depth_m=plot_input.depth_m,
                    centroid_lng=centroid["lng"],
                    centroid_lat=centroid["lat"],
                )
                if plot_input.address:
                    analysis.address_resolved = plot_input.address
                return analysis

            elif plot_input.vertices_m:
                centroid = geo_result if geo_result else _DEFAULT_CENTROID
                analysis = geometry.analyze_from_local_vertices(
                    vertices=plot_input.vertices_m,
                    centroid_lng=centroid["lng"],
                    centroid_lat=centroid["lat"],
                )
                if plot_input.address:
                    analysis.address_resolved = plot_input.address
                return analysis

        raise HTTPException(
            status_code=400,
            detail="Invalid input: provide boundary_polygon (coordinates mode) or width_m/depth_m (address mode)",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
