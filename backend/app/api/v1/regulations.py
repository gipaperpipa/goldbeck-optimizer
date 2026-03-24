from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from app.models.regulation import (
    RegulationSet,
    RegulationValidationResult,
    RegulationLookupRequest,
    RegulationLookupResponse,
)
from app.services.regulation_engine import RegulationEngine
from app.services.ai_regulation_lookup import lookup_regulations
from app.services.german_regulations import (
    GermanRegulationEngine,
    GermanRegulationSet,
    get_german_presets,
    get_german_states_list,
)

router = APIRouter()
engine = RegulationEngine()
german_engine = GermanRegulationEngine()


# ============================================================
# Existing (International) Endpoints
# ============================================================

@router.post("/validate", response_model=RegulationValidationResult)
async def validate_regulations(regulations: RegulationSet):
    return engine.validate(regulations)


@router.post("/lookup", response_model=RegulationLookupResponse)
async def lookup_regulation(request: RegulationLookupRequest):
    try:
        return await lookup_regulations(
            address=request.address,
            city=request.city,
            state=request.state,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# German Regulation Endpoints
# ============================================================

class GermanRegulationRequest(BaseModel):
    """Request to build a German regulation set."""
    bundesland: str = "Nordrhein-Westfalen"
    baugebiet: str = "WA"
    building_height_m: float = 12.0
    num_stories: int = 4
    is_core_area: bool = False
    near_transit: bool = False


class GermanComplianceRequest(BaseModel):
    """Request to check compliance against German regulations."""
    regulations: GermanRegulationSet
    plot_area_sqm: float
    building_footprint_sqm: float
    gross_floor_area_sqm: float
    building_height_m: float
    num_stories: int
    num_apartments: int


@router.get("/german/presets")
async def get_presets():
    """Get all German Baugebiet presets (BauNVO §17)."""
    return get_german_presets()


@router.get("/german/states")
async def get_states():
    """Get list of German states with regulation highlights."""
    return get_german_states_list()


@router.post("/german/build")
async def build_german_regulations(request: GermanRegulationRequest):
    """Build a complete German regulation set from parameters.

    Computes GRZ/GFZ from BauNVO, Abstandsflächen from state LBO,
    Stellplätze, Gebäudeklasse, and fire safety requirements.
    """
    try:
        german_regs = GermanRegulationEngine.build_regulation_set(
            bundesland=request.bundesland,
            baugebiet=request.baugebiet,
            building_height_m=request.building_height_m,
            num_stories=request.num_stories,
            is_core_area=request.is_core_area,
            near_transit=request.near_transit,
        )
        # Also provide backward-compatible RegulationSet
        compat = GermanRegulationEngine.convert_to_regulation_set(german_regs)
        return {
            "german": german_regs.model_dump(),
            "compatible": compat,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/german/check-compliance")
async def check_german_compliance(request: GermanComplianceRequest):
    """Validate a building design against German regulations."""
    try:
        return GermanRegulationEngine.validate_compliance(
            german_regs=request.regulations,
            plot_area_sqm=request.plot_area_sqm,
            building_footprint_sqm=request.building_footprint_sqm,
            gross_floor_area_sqm=request.gross_floor_area_sqm,
            building_height_m=request.building_height_m,
            num_stories=request.num_stories,
            num_apartments=request.num_apartments,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/german/to-compatible")
async def convert_german_to_compatible(german_regs: GermanRegulationSet):
    """Convert German regulation set to international-compatible format."""
    return GermanRegulationEngine.convert_to_regulation_set(german_regs)
