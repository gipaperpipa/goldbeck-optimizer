"""
Abstract base class for pluggable construction systems.
"""

from abc import ABC, abstractmethod
from typing import Optional
from app.models.floorplan import BuildingFloorPlans, FloorPlanRequest


class ConstructionSystem(ABC):
    """Base class for construction system floor plan generators."""

    @property
    @abstractmethod
    def system_name(self) -> str:
        """Unique identifier for this construction system."""
        ...

    @abstractmethod
    def generate_floor_plans(
        self,
        request: FloorPlanRequest,
        variation_params: Optional[dict] = None,
    ) -> BuildingFloorPlans:
        """Generate complete floor plans for a building."""
        ...

    @abstractmethod
    def validate_building(self, width_m: float, depth_m: float, stories: int) -> list[str]:
        """Return list of warnings about why this building may not fit the system."""
        ...
