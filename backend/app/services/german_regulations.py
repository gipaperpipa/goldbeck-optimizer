"""
German building regulation engine.

Implements BauNVO §17, state-specific Landesbauordnungen (LBOs),
Abstandsflächenrecht, Stellplatzverordnungen, and fire safety rules
for all 16 German states.

References:
  - BauNVO §17 (GRZ/GFZ by Baugebiet type)
  - BauGB §34 (Innenbereich), §30 (Bebauungsplan)
  - State LBOs for Abstandsflächen, Vollgeschoss, fire safety
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


# ============================================================
# 1. BAUGEBIET (Zoning Area Types per BauNVO)
# ============================================================

class BaugebietType(str, Enum):
    """BauNVO zoning area types with German abbreviations."""
    WR = "WR"    # Reines Wohngebiet (pure residential)
    WA = "WA"    # Allgemeines Wohngebiet (general residential)
    WB = "WB"    # Besonderes Wohngebiet (special residential)
    MI = "MI"    # Mischgebiet (mixed use)
    MU = "MU"    # Urbanes Gebiet (urban area, since 2017)
    MK = "MK"    # Kerngebiet (core/commercial center)
    GE = "GE"    # Gewerbegebiet (commercial)
    GI = "GI"    # Industriegebiet (industrial)
    SO = "SO"    # Sondergebiet (special area)


class GermanState(str, Enum):
    """All 16 German federal states."""
    BW = "Baden-Württemberg"
    BY = "Bayern"
    BE = "Berlin"
    BB = "Brandenburg"
    HB = "Bremen"
    HH = "Hamburg"
    HE = "Hessen"
    MV = "Mecklenburg-Vorpommern"
    NI = "Niedersachsen"
    NW = "Nordrhein-Westfalen"
    RP = "Rheinland-Pfalz"
    SL = "Saarland"
    SN = "Sachsen"
    ST = "Sachsen-Anhalt"
    SH = "Schleswig-Holstein"
    TH = "Thüringen"


# ============================================================
# 2. BauNVO §17 — GRZ/GFZ LIMITS BY BAUGEBIET
# ============================================================

# BauNVO §17 Abs. 1: Obergrenzen für die Bestimmung des Maßes
# der baulichen Nutzung
BAUNVO_LIMITS: dict[str, dict] = {
    "WR": {"grz": 0.4, "gfz": 1.2, "bmz": None, "label": "Reines Wohngebiet"},
    "WA": {"grz": 0.4, "gfz": 1.2, "bmz": None, "label": "Allgemeines Wohngebiet"},
    "WB": {"grz": 0.4, "gfz": 1.6, "bmz": None, "label": "Besonderes Wohngebiet"},
    "MI": {"grz": 0.6, "gfz": 1.2, "bmz": None, "label": "Mischgebiet"},
    "MU": {"grz": 0.8, "gfz": 3.0, "bmz": None, "label": "Urbanes Gebiet"},
    "MK": {"grz": 1.0, "gfz": 3.0, "bmz": None, "label": "Kerngebiet"},
    "GE": {"grz": 0.8, "gfz": 2.4, "bmz": 10.0, "label": "Gewerbegebiet"},
    "GI": {"grz": 0.8, "gfz": 2.4, "bmz": 10.0, "label": "Industriegebiet"},
    "SO": {"grz": 0.8, "gfz": 2.4, "bmz": None, "label": "Sondergebiet"},
}


# ============================================================
# 3. ABSTANDSFLÄCHEN PER STATE
# ============================================================

# Each state's LBO defines Abstandsflächen as factor × building height H.
# Minimum absolute distance is also specified.
# Some states differentiate between core/inner city and outer areas.

class AbstandsflConfig(BaseModel):
    """State-specific Abstandsflächen (setback) configuration."""
    factor_default: float = 0.4       # Multiplier × H (building height)
    factor_core_area: float = 0.25    # Reduced factor in Kerngebiet/inner city
    min_distance_m: float = 3.0       # Absolute minimum in meters
    applies_to_boundary: bool = True  # True = measured to property boundary

ABSTANDSFLAECHEN_BY_STATE: dict[str, AbstandsflConfig] = {
    "Baden-Württemberg":       AbstandsflConfig(factor_default=0.4, factor_core_area=0.2, min_distance_m=2.5),
    "Bayern":                  AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Berlin":                  AbstandsflConfig(factor_default=0.4, factor_core_area=0.2, min_distance_m=3.0),
    "Brandenburg":             AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Bremen":                  AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Hamburg":                 AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=2.5),
    "Hessen":                  AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Mecklenburg-Vorpommern":  AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Niedersachsen":           AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Nordrhein-Westfalen":     AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Rheinland-Pfalz":         AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Saarland":                AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Sachsen":                 AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Sachsen-Anhalt":          AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Schleswig-Holstein":      AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
    "Thüringen":               AbstandsflConfig(factor_default=0.4, factor_core_area=0.25, min_distance_m=3.0),
}


# ============================================================
# 4. VOLLGESCHOSS DEFINITIONS PER STATE
# ============================================================

class VollgeschossConfig(BaseModel):
    """State-specific definition of Vollgeschoss (full storey).

    A storey counts as Vollgeschoss if ceiling height ≥ threshold
    over ≥ fraction of the storey's floor area.
    """
    min_height_m: float = 2.30           # Minimum ceiling height
    min_area_fraction: float = 0.75      # Must apply over this fraction (3/4)
    staffelgeschoss_exempt: bool = True  # Setback top floor can be exempt

VOLLGESCHOSS_BY_STATE: dict[str, VollgeschossConfig] = {
    "Baden-Württemberg":       VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Bayern":                  VollgeschossConfig(min_height_m=2.30, min_area_fraction=2/3),
    "Berlin":                  VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Brandenburg":             VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Bremen":                  VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Hamburg":                 VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Hessen":                  VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Mecklenburg-Vorpommern":  VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Niedersachsen":           VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Nordrhein-Westfalen":     VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Rheinland-Pfalz":         VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Saarland":                VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Sachsen":                 VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Sachsen-Anhalt":          VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Schleswig-Holstein":      VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
    "Thüringen":               VollgeschossConfig(min_height_m=2.30, min_area_fraction=0.75),
}


# ============================================================
# 5. STELLPLATZVERORDNUNG (PARKING REQUIREMENTS)
# ============================================================

class StellplatzConfig(BaseModel):
    """State-specific parking space requirements per dwelling unit."""
    spaces_per_unit: float = 1.0                   # Base: 1 per apartment
    spaces_per_unit_social_housing: float = 0.5    # Reduced for social housing
    bicycle_spaces_per_unit: float = 1.0           # Bicycle parking
    visitor_spaces_fraction: float = 0.10          # 10% of total for visitors
    reduction_near_transit_pct: float = 0.0        # Reduction near public transit

STELLPLATZ_BY_STATE: dict[str, StellplatzConfig] = {
    "Baden-Württemberg":       StellplatzConfig(spaces_per_unit=1.0, reduction_near_transit_pct=30),
    "Bayern":                  StellplatzConfig(spaces_per_unit=1.0, reduction_near_transit_pct=0),
    "Berlin":                  StellplatzConfig(spaces_per_unit=0.0, bicycle_spaces_per_unit=2.0),  # No car parking mandate since 2021
    "Brandenburg":             StellplatzConfig(spaces_per_unit=1.0),
    "Bremen":                  StellplatzConfig(spaces_per_unit=0.8, reduction_near_transit_pct=50),
    "Hamburg":                 StellplatzConfig(spaces_per_unit=0.8, reduction_near_transit_pct=40),
    "Hessen":                  StellplatzConfig(spaces_per_unit=1.0),
    "Mecklenburg-Vorpommern":  StellplatzConfig(spaces_per_unit=1.0),
    "Niedersachsen":           StellplatzConfig(spaces_per_unit=1.0, reduction_near_transit_pct=25),
    "Nordrhein-Westfalen":     StellplatzConfig(spaces_per_unit=1.0, reduction_near_transit_pct=30),
    "Rheinland-Pfalz":         StellplatzConfig(spaces_per_unit=1.0),
    "Saarland":                StellplatzConfig(spaces_per_unit=1.0),
    "Sachsen":                 StellplatzConfig(spaces_per_unit=1.0),
    "Sachsen-Anhalt":          StellplatzConfig(spaces_per_unit=1.0),
    "Schleswig-Holstein":      StellplatzConfig(spaces_per_unit=1.0, reduction_near_transit_pct=20),
    "Thüringen":               StellplatzConfig(spaces_per_unit=1.0),
}


# ============================================================
# 6. FIRE SAFETY (BRANDSCHUTZ) — MBO / State LBOs
# ============================================================

class Gebaeuklasse(str, Enum):
    """German building classes per Musterbauordnung (MBO)."""
    GK1 = "GK1"  # Freistehend, ≤7m Höhe, ≤2 NE, ≤400m² GF
    GK2 = "GK2"  # Freistehend, ≤7m Höhe, ≤2 NE
    GK3 = "GK3"  # ≤7m Höhe
    GK4 = "GK4"  # ≤13m Höhe, ≤400m² NE-GF
    GK5 = "GK5"  # Sonstige + Hochhäuser (>22m)


class FireSafetyConfig(BaseModel):
    """Fire safety parameters per building class."""
    max_escape_distance_m: float = 35.0
    min_staircase_width_m: float = 1.0     # ≥1.00m clear width
    second_staircase_height_m: float = 22.0  # Required above this height
    min_corridor_width_m: float = 1.20
    fire_compartment_max_area_sqm: float = 400.0
    smoke_extraction_required_height_m: float = 13.0


FIRE_SAFETY_BY_CLASS: dict[str, FireSafetyConfig] = {
    "GK1": FireSafetyConfig(
        min_staircase_width_m=0.80,
        fire_compartment_max_area_sqm=400,
    ),
    "GK2": FireSafetyConfig(
        min_staircase_width_m=0.80,
        fire_compartment_max_area_sqm=400,
    ),
    "GK3": FireSafetyConfig(
        min_staircase_width_m=1.00,
        fire_compartment_max_area_sqm=400,
    ),
    "GK4": FireSafetyConfig(
        min_staircase_width_m=1.00,
        fire_compartment_max_area_sqm=400,
        smoke_extraction_required_height_m=13.0,
    ),
    "GK5": FireSafetyConfig(
        min_staircase_width_m=1.20,
        fire_compartment_max_area_sqm=400,
        second_staircase_height_m=22.0,
        smoke_extraction_required_height_m=13.0,
    ),
}


# ============================================================
# 7. GERMAN REGULATION SET (composite model)
# ============================================================

class GermanSetbackRequirements(BaseModel):
    """Abstandsflächen-based setbacks (calculated from building height)."""
    factor: float = 0.4
    factor_core: float = 0.25
    min_m: float = 3.0
    # Calculated values (populated by engine)
    front_m: float = 3.0
    rear_m: float = 3.0
    side_left_m: float = 3.0
    side_right_m: float = 3.0


class GermanParkingRequirements(BaseModel):
    """Stellplatz requirements per German regulations."""
    spaces_per_unit: float = 1.0
    bicycle_spaces_per_unit: float = 1.0
    visitor_fraction: float = 0.10
    near_transit_reduction_pct: float = 0.0


class GermanRegulationSet(BaseModel):
    """Complete German regulation set for a specific project location."""
    # Identification
    regulation_system: str = "german"
    bundesland: str = "Nordrhein-Westfalen"
    baugebiet_type: str = "WA"
    baugebiet_label: str = "Allgemeines Wohngebiet"

    # BauNVO density limits
    grz: float = 0.4                       # Grundflächenzahl
    gfz: float = 1.2                       # Geschossflächenzahl
    bmz: Optional[float] = None            # Baumassenzahl (commercial/industrial)

    # Height/stories
    max_stories: int = 4                    # Vollgeschosse
    max_height_m: float = 15.0             # Gebäudehöhe
    story_height_m: float = 2.90

    # Abstandsflächen
    setbacks: GermanSetbackRequirements = Field(default_factory=GermanSetbackRequirements)

    # Grundstücksausnutzung
    max_lot_coverage_pct: float = 40.0     # GRZ as percentage
    min_open_space_pct: float = 60.0       # 1 - GRZ

    # Parking
    parking: GermanParkingRequirements = Field(default_factory=GermanParkingRequirements)

    # Fire safety
    gebaeudeklasse: str = "GK3"
    max_escape_distance_m: float = 35.0
    min_staircase_width_m: float = 1.0
    second_staircase_required: bool = False

    # Vollgeschoss
    vollgeschoss_min_height_m: float = 2.30
    vollgeschoss_area_fraction: float = 0.75
    staffelgeschoss_exempt: bool = True

    # Building separation
    min_building_separation_m: float = 6.0
    fire_access_width_m: float = 3.50       # Feuerwehrzufahrt

    # Additional BauGB
    allow_commercial_ground_floor: bool = False


# ============================================================
# 8. REGULATION ENGINE
# ============================================================

class GermanRegulationEngine:
    """Computes German regulation parameters from location + building data."""

    @staticmethod
    def get_baugebiet_limits(baugebiet: str) -> dict:
        """Get BauNVO §17 limits for a Baugebiet type."""
        return BAUNVO_LIMITS.get(baugebiet, BAUNVO_LIMITS["WA"])

    @staticmethod
    def get_abstandsflaechen(state: str) -> AbstandsflConfig:
        """Get state-specific Abstandsflächen config."""
        return ABSTANDSFLAECHEN_BY_STATE.get(state, AbstandsflConfig())

    @staticmethod
    def get_stellplatz(state: str) -> StellplatzConfig:
        """Get state-specific parking requirements."""
        return STELLPLATZ_BY_STATE.get(state, StellplatzConfig())

    @staticmethod
    def get_vollgeschoss(state: str) -> VollgeschossConfig:
        """Get state-specific Vollgeschoss definition."""
        return VOLLGESCHOSS_BY_STATE.get(state, VollgeschossConfig())

    @staticmethod
    def compute_gebaeudeklasse(
        height_m: float,
        num_units: int,
        unit_floor_area_sqm: float,
    ) -> str:
        """Determine Gebäudeklasse from building parameters."""
        if height_m <= 7.0 and num_units <= 2 and unit_floor_area_sqm <= 400:
            return "GK1"
        elif height_m <= 7.0 and num_units <= 2:
            return "GK2"
        elif height_m <= 7.0:
            return "GK3"
        elif height_m <= 13.0 and unit_floor_area_sqm <= 400:
            return "GK4"
        else:
            return "GK5"

    @staticmethod
    def compute_setbacks(
        building_height_m: float,
        state: str,
        is_core_area: bool = False,
    ) -> GermanSetbackRequirements:
        """Calculate Abstandsflächen from building height and state rules."""
        config = ABSTANDSFLAECHEN_BY_STATE.get(state, AbstandsflConfig())
        factor = config.factor_core_area if is_core_area else config.factor_default

        calculated = max(building_height_m * factor, config.min_distance_m)

        return GermanSetbackRequirements(
            factor=config.factor_default,
            factor_core=config.factor_core_area,
            min_m=config.min_distance_m,
            front_m=calculated,
            rear_m=calculated,
            side_left_m=calculated,
            side_right_m=calculated,
        )

    @staticmethod
    def build_regulation_set(
        bundesland: str = "Nordrhein-Westfalen",
        baugebiet: str = "WA",
        building_height_m: float = 12.0,
        num_stories: int = 4,
        is_core_area: bool = False,
        near_transit: bool = False,
    ) -> GermanRegulationSet:
        """Build a complete GermanRegulationSet from parameters."""

        engine = GermanRegulationEngine

        # BauNVO limits
        limits = engine.get_baugebiet_limits(baugebiet)

        # Abstandsflächen
        setbacks = engine.compute_setbacks(building_height_m, bundesland, is_core_area)

        # Parking
        stellplatz = engine.get_stellplatz(bundesland)
        reduction = stellplatz.reduction_near_transit_pct if near_transit else 0
        effective_spaces = stellplatz.spaces_per_unit * (1 - reduction / 100)

        parking = GermanParkingRequirements(
            spaces_per_unit=effective_spaces,
            bicycle_spaces_per_unit=stellplatz.bicycle_spaces_per_unit,
            visitor_fraction=stellplatz.visitor_spaces_fraction,
            near_transit_reduction_pct=reduction,
        )

        # Vollgeschoss
        vg = engine.get_vollgeschoss(bundesland)

        # Fire safety / Gebäudeklasse
        gk = engine.compute_gebaeudeklasse(building_height_m, 20, 80)
        fire = FIRE_SAFETY_BY_CLASS.get(gk, FireSafetyConfig())

        # Height calculation: stories × story_height
        max_height = max(building_height_m, num_stories * 2.90 + 1.0)

        grz = limits["grz"]

        return GermanRegulationSet(
            bundesland=bundesland,
            baugebiet_type=baugebiet,
            baugebiet_label=limits["label"],
            grz=grz,
            gfz=limits["gfz"],
            bmz=limits.get("bmz"),
            max_stories=num_stories,
            max_height_m=max_height,
            setbacks=setbacks,
            max_lot_coverage_pct=grz * 100,
            min_open_space_pct=(1 - grz) * 100,
            parking=parking,
            gebaeudeklasse=gk,
            max_escape_distance_m=fire.max_escape_distance_m,
            min_staircase_width_m=fire.min_staircase_width_m,
            second_staircase_required=(building_height_m > fire.second_staircase_height_m),
            vollgeschoss_min_height_m=vg.min_height_m,
            vollgeschoss_area_fraction=vg.min_area_fraction,
            staffelgeschoss_exempt=vg.staffelgeschoss_exempt,
            min_building_separation_m=max(setbacks.front_m * 2, 6.0),
            allow_commercial_ground_floor=(baugebiet in ("MI", "MU", "MK")),
        )

    @staticmethod
    def convert_to_regulation_set(german: GermanRegulationSet) -> dict:
        """Convert GermanRegulationSet to the existing RegulationSet format
        for backward compatibility with the optimizer."""
        return {
            "zoning_type": f"DE-{german.baugebiet_type}",
            "setbacks": {
                "front_m": german.setbacks.front_m,
                "rear_m": german.setbacks.rear_m,
                "side_left_m": german.setbacks.side_left_m,
                "side_right_m": german.setbacks.side_right_m,
            },
            "max_far": german.gfz,
            "max_height_m": german.max_height_m,
            "max_stories": german.max_stories,
            "max_lot_coverage_pct": german.max_lot_coverage_pct,
            "min_open_space_pct": german.min_open_space_pct,
            "parking": {
                "studio_ratio": german.parking.spaces_per_unit,
                "one_bed_ratio": german.parking.spaces_per_unit,
                "two_bed_ratio": german.parking.spaces_per_unit,
                "three_bed_ratio": german.parking.spaces_per_unit,
                "commercial_ratio_per_1000sqm": 3.0,
                "guest_ratio": german.parking.visitor_fraction,
            },
            "min_unit_sizes": {
                "studio_sqm": 25.0,
                "one_bed_sqm": 40.0,
                "two_bed_sqm": 55.0,
                "three_bed_sqm": 75.0,
            },
            "fire_access_width_m": german.fire_access_width_m,
            "min_building_separation_m": german.min_building_separation_m,
            "allow_commercial_ground_floor": german.allow_commercial_ground_floor,
        }

    @staticmethod
    def validate_compliance(
        german_regs: GermanRegulationSet,
        plot_area_sqm: float,
        building_footprint_sqm: float,
        gross_floor_area_sqm: float,
        building_height_m: float,
        num_stories: int,
        num_apartments: int,
    ) -> dict:
        """Validate a building design against German regulations.

        Returns dict with violations, warnings, and computed metrics.
        """
        violations = []
        warnings = []

        # GRZ check
        grz_actual = building_footprint_sqm / plot_area_sqm if plot_area_sqm > 0 else 0
        if grz_actual > german_regs.grz:
            violations.append(
                f"GRZ {grz_actual:.2f} überschreitet Höchstwert {german_regs.grz:.2f} "
                f"(BauNVO §17 für {german_regs.baugebiet_type})"
            )

        # GFZ check
        gfz_actual = gross_floor_area_sqm / plot_area_sqm if plot_area_sqm > 0 else 0
        if gfz_actual > german_regs.gfz:
            violations.append(
                f"GFZ {gfz_actual:.2f} überschreitet Höchstwert {german_regs.gfz:.2f} "
                f"(BauNVO §17 für {german_regs.baugebiet_type})"
            )

        # Height check
        if building_height_m > german_regs.max_height_m:
            violations.append(
                f"Gebäudehöhe {building_height_m:.1f}m überschreitet "
                f"zulässige Höhe {german_regs.max_height_m:.1f}m"
            )

        # Vollgeschoss check
        if num_stories > german_regs.max_stories:
            # Check if top floor could be Staffelgeschoss
            if german_regs.staffelgeschoss_exempt and num_stories == german_regs.max_stories + 1:
                warnings.append(
                    f"{num_stories} Geschosse: Oberstes Geschoss muss als "
                    f"Staffelgeschoss (kein Vollgeschoss) ausgeführt werden "
                    f"(Raumhöhe ≥{german_regs.vollgeschoss_min_height_m}m über "
                    f"<{german_regs.vollgeschoss_area_fraction*100:.0f}% der Geschossfläche)"
                )
            else:
                violations.append(
                    f"{num_stories} Vollgeschosse überschreiten zulässige "
                    f"{german_regs.max_stories} Vollgeschosse"
                )

        # Parking
        required_spaces = num_apartments * german_regs.parking.spaces_per_unit
        required_bicycle = num_apartments * german_regs.parking.bicycle_spaces_per_unit

        # Abstandsflächen (info)
        setback_info = (
            f"Abstandsflächen: {german_regs.setbacks.factor}×H = "
            f"{german_regs.setbacks.front_m:.1f}m (min. {german_regs.setbacks.min_m:.1f}m)"
        )

        return {
            "is_compliant": len(violations) == 0,
            "violations": violations,
            "warnings": warnings,
            "metrics": {
                "grz_actual": round(grz_actual, 3),
                "grz_max": german_regs.grz,
                "gfz_actual": round(gfz_actual, 3),
                "gfz_max": german_regs.gfz,
                "building_height_m": building_height_m,
                "max_height_m": german_regs.max_height_m,
                "num_stories": num_stories,
                "max_stories": german_regs.max_stories,
                "parking_required": required_spaces,
                "bicycle_parking_required": required_bicycle,
                "setback_info": setback_info,
                "gebaeudeklasse": german_regs.gebaeudeklasse,
            },
        }


# ============================================================
# 9. PRESET CONFIGURATIONS
# ============================================================

def get_german_presets() -> dict[str, dict]:
    """Return preset configurations for common German zoning scenarios."""
    engine = GermanRegulationEngine

    presets = {}
    for baugebiet in ["WR", "WA", "MI", "MU", "MK"]:
        limits = BAUNVO_LIMITS[baugebiet]
        preset = engine.build_regulation_set(
            bundesland="Nordrhein-Westfalen",
            baugebiet=baugebiet,
            building_height_m=12.0,
            num_stories=4,
        )
        presets[baugebiet] = {
            "label": limits["label"],
            "config": preset.model_dump(),
        }

    return presets


def get_german_states_list() -> list[dict]:
    """Return list of German states with their regulation highlights."""
    states = []
    for state_enum in GermanState:
        state_name = state_enum.value
        abstand = ABSTANDSFLAECHEN_BY_STATE.get(state_name, AbstandsflConfig())
        stellplatz = STELLPLATZ_BY_STATE.get(state_name, StellplatzConfig())
        vg = VOLLGESCHOSS_BY_STATE.get(state_name, VollgeschossConfig())

        states.append({
            "key": state_enum.name,
            "name": state_name,
            "abstandsflaechen_factor": abstand.factor_default,
            "abstandsflaechen_min_m": abstand.min_distance_m,
            "stellplatz_per_unit": stellplatz.spaces_per_unit,
            "vollgeschoss_height_m": vg.min_height_m,
            "vollgeschoss_fraction": vg.min_area_fraction,
        })

    return states
