"""
Construction system registry - allows selecting floor plan generators by name.
"""

from app.services.floorplan.base import ConstructionSystem

_SYSTEMS: dict[str, ConstructionSystem] = {}


def register_system(system: ConstructionSystem):
    """Register a construction system by its name."""
    _SYSTEMS[system.system_name] = system


def get_system(name: str) -> ConstructionSystem:
    """Get a registered construction system by name."""
    if name not in _SYSTEMS:
        available = ", ".join(_SYSTEMS.keys()) if _SYSTEMS else "none"
        raise ValueError(
            f"Unknown construction system: '{name}'. Available: {available}"
        )
    return _SYSTEMS[name]


def list_systems() -> list[str]:
    """List all registered construction system names."""
    return list(_SYSTEMS.keys())


# Auto-register built-in systems on import
def _auto_register():
    from app.services.floorplan.goldbeck_generator import GoldbeckGenerator
    register_system(GoldbeckGenerator())


_auto_register()
