"""IFC export endpoint."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.models.building import BuildingFootprint
from app.models.floorplan import BuildingFloorPlans
from app.services.ifc_exporter import IfcWriter

router = APIRouter()


class ExportIfcRequest(BaseModel):
    building: BuildingFootprint
    floor_plans: BuildingFloorPlans


@router.post("/ifc")
async def export_ifc(request: ExportIfcRequest):
    """Generate and return an IFC file for a building."""
    try:
        writer = IfcWriter()
        ifc_content = writer.export_building(request.building, request.floor_plans)
        return Response(
            content=ifc_content,
            media_type="application/x-step",
            headers={
                "Content-Disposition": f'attachment; filename="building_{request.building.id}.ifc"',
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"IFC export failed: {str(e)}")
