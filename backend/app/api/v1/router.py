from fastapi import APIRouter

from app.api.v1 import plot, regulations, optimize, financial, shadow, floorplan, export, cadastral

api_router = APIRouter()

api_router.include_router(plot.router, prefix="/plot", tags=["plot"])
api_router.include_router(cadastral.router, prefix="/cadastral", tags=["cadastral"])
api_router.include_router(regulations.router, prefix="/regulations", tags=["regulations"])
api_router.include_router(optimize.router, prefix="/optimize", tags=["optimize"])
api_router.include_router(financial.router, prefix="/financial", tags=["financial"])
api_router.include_router(shadow.router, prefix="/shadow", tags=["shadow"])
api_router.include_router(floorplan.router, prefix="/floorplan", tags=["floorplan"])
api_router.include_router(export.router, prefix="/export", tags=["export"])
