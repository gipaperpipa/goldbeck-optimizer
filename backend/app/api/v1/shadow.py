from fastapi import APIRouter, HTTPException

from app.models.shadow import ShadowRequest, ShadowResult
from app.services.shadow_calculator import ShadowCalculator

router = APIRouter()
calculator = ShadowCalculator()


@router.post("/analyze", response_model=ShadowResult)
async def analyze_shadows(request: ShadowRequest):
    try:
        return calculator.analyze(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
