from fastapi import APIRouter, HTTPException

from app.models.financial import FinancialAnalysisRequest, FinancialAnalysis
from app.services.financial_calculator import FinancialCalculator

router = APIRouter()
calculator = FinancialCalculator()


@router.post("/analyze", response_model=FinancialAnalysis)
async def analyze_financials(request: FinancialAnalysisRequest):
    try:
        return calculator.analyze(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
