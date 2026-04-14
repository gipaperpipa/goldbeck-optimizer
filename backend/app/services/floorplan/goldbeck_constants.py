"""
Goldbeck Wohngebäude construction system constants.
All dimensions in meters. Extracted from Produktleitfaden Mai 2024.
"""

# --- Room Aspect Ratio Targets (Phase 2.3) ---
# Ideal min/max edge ratio (short/long) per room type, used by the optimizer's
# room_aspect_ratios criterion as a Gaussian-scored target. 1.0 = square.
IDEAL_ASPECT_RATIOS = {
    "LIVING":  0.70,  # near-square, slight rectangle
    "BEDROOM": 0.65,
    "KITCHEN": 0.55,  # galley-tolerant
    "BATH":    0.50,
}
ASPECT_SIGMA = 0.18  # std-dev of the Gaussian — wider = more permissive

# --- Grid System ---
GRID_UNIT = 0.625  # Base module (Grundraster)
STANDARD_RASTERS = [3.125, 3.75, 4.375, 5.00, 5.625, 6.25]  # Valid bay widths
HALF_RASTERS = [0.625, 1.875, 3.125, 4.375, 5.625]
MAX_BAY_WIDTH = 6.25   # Maximum deck span (Achsraster)
MIN_BAY_WIDTH = 3.125   # Minimum practical bay

# --- Conversion ---
FT_TO_M = 0.3048
M_TO_FT = 3.28084

# --- Wall Thicknesses (meters) ---
BEARING_CROSS_WALL = 0.21    # Querwand (tragende Innenwand)
CORRIDOR_WALL = 0.21          # Flurwand (tragend)
OUTER_LONG_WALL = 0.14        # Nicht tragende Außenlängswand
GABLE_END_WALL = 0.21         # Giebelwand (tragend)
STAIRCASE_WALL = 0.21         # Treppenhauswand
ELEVATOR_SHAFT_WALL = 0.24    # Aufzugschachtwand
PARTITION_WALL = 0.10          # Nichttragende Innenwand (Trockenbau)
PARTITION_WALL_THICK = 0.125   # Thicker drywall option (75mm Ständerwerk)

# --- Wall Axis Positions ---
# 21cm walls: axis at center (10.5/10.5cm)
BEARING_WALL_HALF = 0.105
# 14cm outer walls: axis 10.5cm from outside, 3.5cm from inside
OUTER_WALL_OUTSIDE = 0.105
OUTER_WALL_INSIDE = 0.035

# --- Floor Slabs ---
SLAB_THICKNESS = 0.24         # Hohlkammerdecke d=24cm
MAX_SLAB_SPAN = 6.04          # Clear span (6.25m on axis)

# --- Story Heights ---
STORY_HEIGHT_STANDARD_A = 2.90   # Standard option A
STORY_HEIGHT_STANDARD_B = 3.07   # Standard option B
STORY_HEIGHT_ELEVATED_GF = 3.41  # Erhöhtes Erdgeschoss
STORY_HEIGHT_ELEVATED_GF_B = 3.24  # Erhöhtes EG variant B
MAX_STORIES = 8                   # Max stories + basement

# --- Building Classes (German) ---
BUILDING_CLASS_3_MAX_HEIGHT = 7.0    # m
BUILDING_CLASS_4_MAX_HEIGHT = 13.0   # m
BUILDING_CLASS_5_MAX_HEIGHT = 22.0   # High-rise limit (Hochhausgrenze)

# --- Prefab Bathrooms (width x depth in meters) ---
BATHROOM_DIMENSIONS = {
    "type_i": {"width": 2.25, "depth": 2.60, "area": 5.84, "barrier_free": True, "has_washer": True},
    "type_ii": {"width": 1.61, "depth": 2.96, "area": 4.76, "barrier_free": True, "has_washer": False},
    "type_iii": {"width": 1.34, "depth": 1.96, "area": 2.62, "barrier_free": False, "has_washer": False},
    "type_iv": {"width": 1.82, "depth": 2.32, "area": 4.22, "barrier_free": True, "has_washer": False},
}

# --- Updated Bathroom Type Detail Dimensions (from PDF detailed drawings) ---
# Fertigmaß (finished dimensions) as read from the detailed bathroom pages
BATHROOM_FINISHED_DIMS = {
    "type_i": {"width": 3.50, "depth": 2.21, "has_window_option": True},
    "type_ii": {"width": 2.90, "depth": 2.21, "has_window_option": True},
    "type_iii": {"width": 1.34, "depth": 1.19, "has_window_option": False},
    "type_iv": {"width": 1.94, "depth": 1.80, "has_window_option": True},
}

# --- Staircase Types ---
STAIRCASE_DIMENSIONS = {
    "type_i": {
        "raster_width": 6.25,      # Can also be 5.625
        "min_raster_width": 5.00,
        "has_elevator": True,
        "wheelchair_accessible": True,
        "depth": None,              # Full building depth (spans corridor)
    },
    "type_ii": {
        "raster_width": 3.125,
        "min_raster_width": 3.125,
        "has_elevator": False,
        "wheelchair_accessible": False,
        "depth": None,              # Full building depth
    },
    "type_iii": {
        "raster_width": 3.125,
        "min_raster_width": 3.125,
        "has_elevator": False,
        "wheelchair_accessible": False,
        "depth": None,              # Full building depth
    },
}

# --- Elevator Dimensions (from PDF) ---
ELEVATOR_SHAFT_DIMS = {
    "W1B_630kg": {"shaft_w": 1.60, "shaft_d": 1.77, "cabin_w": 1.10, "cabin_d": 1.40},
    "W2B_1000kg": {"shaft_w": 1.60, "shaft_d": 2.47, "cabin_w": 1.10, "cabin_d": 2.10},
}

# --- Staircase Detailed Dimensions ---
STAIRCASE_MIN_WALL_EDGE_TO_DOOR = 0.30  # 300mm min from wall element edge to door/window reveal

# --- Apartment Storage Requirements ---
IN_UNIT_STORAGE_MIN_M2 = 1.5  # Minimum in-unit storage area
IN_UNIT_STORAGE_MAX_M2 = 2.0  # Reference maximum
ADDITIONAL_STORAGE_REFERENCE_M2 = 5.0  # Additional storage (basement etc)

# --- Doors ---
ENTRANCE_DOOR_EXTERIOR_WIDTH_A = 1.25   # Hauseingangstür variant A
ENTRANCE_DOOR_EXTERIOR_WIDTH_B = 1.50   # Hauseingangstür variant B
APARTMENT_ENTRANCE_DOOR_WIDTH = 1.01    # Wohnungseingangstür
APARTMENT_ENTRANCE_DOOR_HEIGHT = 2.135
INTERIOR_DOOR_WIDTH = 0.885              # Zimmertür
INTERIOR_DOOR_HEIGHT = 2.135
WHEELCHAIR_DOOR_WIDTH = 1.01             # Also for wheelchair-accessible rooms
CORRIDOR_DOOR_WIDTH = 1.26               # Flurtür (fire-rated)

# --- Windows ---
WINDOW_WIDTHS = [0.625, 1.25, 1.50, 1.875]
WINDOW_HEIGHT_FLOOR_TO_CEILING = 2.24    # Bodentiefe Fenster (floor-to-ceiling)
WINDOW_HEIGHT_PARAPET = 1.34             # Brüstungsfenster (parapet window)
WINDOW_SILL_HEIGHT = 0.90               # Brüstungshöhe
ROLLER_SHUTTER_HEIGHT = 0.262           # Rolladenkasten
MIN_EDGE_TO_OPENING = 0.60              # Min from wall edge to window (Außenwand)
MIN_BETWEEN_OPENINGS = 0.90             # Min between two openings
MIN_CORNER_TO_OPENING = 1.75            # Corner of building to first opening

# --- Wall Opening Manufacturing Rules ---
LOAD_BEARING_INNER_WALL_MIN_EDGE_TO_OPENING = 0.30  # 30cm min from edge to opening in bearing inner walls
# Note: MIN_EDGE_TO_OPENING (0.60) and MIN_BETWEEN_OPENINGS (0.90) already exist for outer walls
# MIN_CORNER_TO_OPENING (1.75) already exists

# --- Vertical Alignment ---
PIER_VERTICAL_ALIGNMENT_REQUIRED = True  # Piers must align through all storeys

# --- Balconies ---
BALCONY_MIN_WIDTH = 2.00                 # Barrier-free minimum
BALCONY_MIN_DEPTH = 1.60                 # Barrier-free minimum
BALCONY_MAX_DEPTH_FOUR_POST = 2.40       # Vierstützen
BALCONY_MAX_DEPTH_TWO_POST = 1.60        # Zweistützen
BALCONY_SETBACK_TRIGGER_DEPTH = 1.50     # Depths > this create setback issues
BALCONY_STANDARD_WIDTH = 3.20            # Standard balcony width
BALCONY_STANDARD_DEPTH = 1.60            # Two-post standard depth

# --- Raster Field Rules ---
CORRIDOR_INTERMEDIATE_RASTER = 1.875  # Intermediate raster for corridor zones
CORRIDOR_CLEAR_WIDTH_REFERENCE = 1.665  # Clear width reference from corridor raster

# --- Access Type Thresholds ---
GANGHAUS_MIN_DEPTH = 10.0                # Minimum building depth for Ganghaus
LAUBENGANG_MIN_DEPTH = 6.25             # Minimum building depth for Laubengang (external gallery)
CORRIDOR_WIDTH = 1.50                     # Central corridor width (min for wheelchair)

# --- Laubengang (External Gallery / Walkway) ---
GALLERY_WIDTH = 1.50                     # External gallery walkway width (barrier-free min)
GALLERY_RAILING_HEIGHT = 1.10            # Balustrade/railing height
GALLERY_SLAB_THICKNESS = 0.20            # Gallery floor slab thickness
GALLERY_SIDE = "north"                   # Default side for external gallery

# --- Laubengang Depth Configs (single apartment zone, full depth) ---
# Each entry is the apartment zone depth (no corridor subtracted)
LAUBENGANG_DEPTH_OPTIONS = [6.25, 5.625, 5.00, 4.375, 3.75, 3.125]

# --- Staircase Spacing ---
MAX_TRAVEL_DISTANCE = 35.0               # Max distance to staircase (German code)
PRACTICAL_STAIRCASE_SPACING = 25.0       # Practical placement interval

# --- Floor build-up ---
FLOOR_BUILDUP_HEIGHT = 0.150             # Schwimmender Estrich total

# --- Apartment-to-Bay Mapping (Goldbeck catalog specifications) ---
# Maps apartment types to their bay requirements
APARTMENT_BAY_SPECS = {
    "1_room": {
        "bay_count": 1,
        "min_total_width": 3.125,
        "max_total_width": 6.25,
        "preferred_rasters": [5.00, 3.75, 6.25, 3.125],
        "primary_bathroom": "type_iv",
        "secondary_bathroom": None,
        "target_area_sqm": 27.0,       # Typical middle value
        "min_area_sqm": 16.0,
        "max_area_sqm": 35.0,
    },
    "2_room": {
        "bay_count": 1,
        "min_total_width": 6.25,
        "max_total_width": 6.25,
        "preferred_rasters": [6.25],
        "primary_bathroom": "type_i",
        "secondary_bathroom": None,
        "target_area_sqm": 55.0,
        "min_area_sqm": 50.0,
        "max_area_sqm": 60.0,
    },
    "3_room": {
        "bay_count": 2,
        "min_total_width": 8.75,       # 5.00 + 3.75
        "max_total_width": 11.25,      # 5.00 + 6.25
        "preferred_rasters": [5.00, 6.25],
        "primary_bathroom": "type_i",
        "secondary_bathroom": None,
        "target_area_sqm": 67.0,
        "min_area_sqm": 60.0,
        "max_area_sqm": 70.0,
    },
    "4_room": {
        "bay_count": 2,
        "min_total_width": 11.25,      # 5.00 + 6.25
        "max_total_width": 12.50,      # 6.25 + 6.25
        "preferred_rasters": [6.25, 6.25],
        "primary_bathroom": "type_i",
        "secondary_bathroom": "type_iii",
        "target_area_sqm": 80.0,
        "min_area_sqm": 75.0,
        "max_area_sqm": 85.0,
    },
    "5_room": {
        "bay_count": 3,
        "min_total_width": 14.375,     # 3.125 + 5.625 + 5.625
        "max_total_width": 15.625,     # 3.125 + 6.25 + 6.25
        "preferred_rasters": [3.125, 6.25, 6.25],
        "primary_bathroom": "type_i",
        "secondary_bathroom": "type_iii",
        "target_area_sqm": 98.0,
        "min_area_sqm": 90.0,
        "max_area_sqm": 100.0,
    },
}

# --- Unit Type Mapping (optimizer types → Goldbeck types) ---
UNIT_TYPE_TO_APARTMENT = {
    "studio": "1_room",
    "1br": "2_room",
    "2br": "3_room",
    "3br": "4_room",
}

# --- Room Layout Templates ---
# Hallway depth from corridor wall
HALLWAY_DEPTH = 1.50
# Kitchen depth (typical)
KITCHEN_DEPTH = 2.50
# Shaft zone width (TGA Schacht between bath and kitchen)
SHAFT_ZONE_WIDTH = 0.30
# Utility panel (Vorsatzschale) depth
UTILITY_PANEL_DEPTH = 0.19

# --- TGA Module ---
TGA_VORSATZSCHALE_DEPTH = 0.19  # TGA lining wall depth (already exists as UTILITY_PANEL_DEPTH)

# --- Depth Configurations for Ganghaus ---
# (south_zone_raster, north_zone_raster) → total depth with corridor
GANGHAUS_DEPTH_CONFIGS = [
    (6.25, 6.25),      # 12.50m + corridor → ~14.21m total
    (5.625, 6.25),     # 11.875m + corridor → ~13.585m total
    (5.625, 5.625),    # 11.25m + corridor → ~12.96m total
    (5.00, 6.25),      # 11.25m + corridor → ~12.96m total
    (5.00, 5.00),      # 10.00m + corridor → ~11.71m total
    (5.00, 5.625),     # 10.625m + corridor → ~12.335m total
    (3.75, 6.25),      # 10.00m + corridor → ~11.71m total
    (3.75, 5.00),      # 8.75m + corridor → ~10.46m total
    (3.125, 6.25),     # 9.375m + corridor → ~11.085m total
    (3.125, 5.00),     # 8.125m + corridor → ~9.835m total
]

# Spaenner: single depth zone
SPAENNER_DEPTH_OPTIONS = [6.25, 5.625, 5.00, 4.375, 3.75, 3.125]

# --- Room colors for rendering ---
ROOM_COLORS = {
    "living": "#dbeafe",        # Light blue
    "bedroom": "#fef3c7",       # Light amber
    "kitchen": "#d1fae5",       # Light green
    "bathroom": "#ede9fe",      # Light purple
    "hallway": "#f1f5f9",       # Light slate
    "storage": "#fce7f3",       # Light pink
    "balcony": "#ccfbf1",       # Light teal
    "corridor": "#f8fafc",      # Lightest gray
    "staircase": "#fee2e2",     # Light red
    "elevator": "#fef9c3",      # Light yellow
    "shaft": "#e5e7eb",         # Gray
}
