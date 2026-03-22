from fastapi import APIRouter, HTTPException

from app.models.regulation import (
    RegulationSet,
    RegulationValidationResult,
    RegulationLookupRequest,
    RegulationLookupResponse,
)
from app.services.regulation_engine import RegulationEngine
from app.services.ai_regulation_lookup import lookup_regulations

router = APIRouter()
engine = RegulationEngine()


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
