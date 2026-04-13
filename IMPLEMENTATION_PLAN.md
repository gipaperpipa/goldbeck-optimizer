# Goldbeck Optimizer — Next Implementation Plan

**Created:** 2026-04-13
**Author:** Adrian Krasniqi + Claude
**Status:** Draft — under discussion

---

## Overview

Three parallel workstreams to take the optimizer from "generates valid floor plans" to "generates excellent floor plans with a professional interactive editor":

1. **Per-Floor Independent Generation** — Each floor gets its own layout
2. **Generation Intelligence** — Solar, acoustic, proportions, efficiency
3. **Interactive Plan Editor** — Full-viewport, dual-mode, editable floor plans

These are ordered by dependency. Phase 1 is foundational — Phases 2 and 3 can run in parallel after it.

---

## Phase 1: Per-Floor Independent Generation

### Problem

The generator creates one floor plan and copies it to all stories. The Staffelgeschoss code exists but produces a reduced copy, not a truly independent layout. Ground floors have no special treatment beyond door placement. Every floor is identical.

### What changes

**1.1 — Floor type system**

Introduce a per-floor configuration that the generator processes independently:

```
FloorConfig:
  floor_index: int
  floor_type: "ground" | "standard" | "staffelgeschoss"
  unit_mix_override: optional per-floor unit mix
  dimensions: optional override (for setbacks)
  access_type_override: optional (ground floor could differ)
  constraints: list (e.g., "min 1 accessible unit", "commercial allowed")
```

The optimizer's chromosome grows to include per-floor variation genes:
- `floor_unit_mix_bias: list[float]` — per-floor bias toward smaller/larger units
- `floor_allocation_seed: list[int]` — different allocation orders per floor
- `ground_floor_mode: str` — "residential" | "mixed_use" | "accessible_priority"

**1.2 — Ground floor differentiation**

Ground floors in German multifamily housing are different:
- All barrier-free units go here (BauO NRW §50)
- Potential Gewerbe (commercial) units at street level
- Direct exterior access (already partially implemented)
- Bike storage, stroller rooms, utility rooms
- Different ceiling heights possible (3.30m vs 2.90m)

**1.3 — Staffelgeschoss proper generation**

Current code reduces dimensions and re-runs the generator. Fix:
- Setback on both gable ends + one long side (configurable)
- Independent bay layout (fewer bays, potentially wider)
- Own unit mix (typically smaller/premium penthouse units)
- Terrace generation where the setback creates a roof surface
- Visual offset in 3D viewer (already supported via grid origin)

**1.4 — Floor-to-floor structural continuity**

Independent generation per floor must respect:
- Bearing walls must stack vertically (Schottwand continuity)
- Staircase positions must align across all floors
- TGA shafts must stack (bathroom vertical alignment)
- Bay widths can only change at Staffelgeschoss transitions

This means: standard floors share the same structural grid, but apartment allocation, room proportions, and unit mix can vary. Only Staffelgeschoss gets a different grid.

### Files affected

| File | Change |
|------|--------|
| `models/floorplan.py` | Add `FloorConfig` model, extend `FloorPlanRequest` |
| `goldbeck_generator.py` | `generate_floor_plans()` loops per floor with config |
| `optimizer.py` | Chromosome adds per-floor genes, fitness evaluates all floors |
| `quality_scoring.py` | Cross-floor scoring (bathroom stacking, wall alignment) |
| `floor-plan-panel.tsx` | Per-floor controls, floor comparison view |

### Estimated scope

Backend: ~300 lines new/modified
Frontend: ~100 lines new
Optimizer: ~150 lines new

---

## Phase 2: Generation Intelligence

### 2.1 — Solar Orientation Awareness

**Problem:** Living rooms and balconies should face south/southwest. The generator assigns rooms without knowing which direction the building faces.

**Data flow:**
- Parcel data includes the building's rotation angle on the plot
- `FloorPlanRequest` already has access to plot orientation
- Generator receives building rotation → determines which side is south-facing
- Room assignment logic flips: Wohnküche goes to the sun side, bedrooms to the quieter/cooler side

**Implementation:**
- Add `building_orientation_deg: float` to `FloorPlanRequest` (0° = north facade faces north)
- In Phase 6 room generation: determine which `side` ("south"/"north") gets more sun
- Wohnküche and balcony → sun side; bedrooms → opposite (cooler, quieter)
- Ganghaus: south-side apartments get living rooms facing exterior (south), north-side apartments get bedrooms facing exterior
- Quality scoring: strengthen the existing orientation criterion (currently lines 476-512 in quality_scoring.py) with seasonal solar gain calculations

**Fitness integration:**
- Increase orientation weight from current 1.0 to 1.5 in livability group
- Add penalty for north-facing Wohnküchen (currently only a mild score reduction)

### 2.2 — Acoustic Zoning

**Problem:** A bedroom sharing a party wall with a neighbor's kitchen or bathroom is a noise issue. The generator doesn't consider inter-apartment adjacency.

**Rules:**
- Service strips should mirror across bearing walls (bath ↔ bath, hall ↔ hall)
- Bedrooms should not share a cross-wall with a neighbor's wet room
- Bedrooms adjacent to staircases get a noise penalty
- Living rooms can tolerate more noise than bedrooms

**Implementation:**
- After Phase 5 allocation, analyze adjacency pairs across bearing walls
- New fitness criterion: `acoustic_separation` (0-10 scale)
  - Bath-to-bath across wall: 10 (ideal)
  - Hall-to-hall: 8 (good)
  - Bedroom-to-bedroom: 7 (acceptable)
  - Living-to-living: 6 (acceptable)
  - Bedroom-to-kitchen/bath: 2 (poor)
  - Bedroom-to-staircase: 3 (poor)
- Service layout order variation (`hall_bath_kitchen` etc.) already exists as an optimizer knob — this criterion naturally rewards the best permutation

### 2.3 — Room Proportion Optimization

**Problem:** The generator enforces minimum areas (DIN 18011) but a 15m² bedroom at 2.5m × 6m is technically valid but barely livable.

**Target ratios:**
- Bedrooms: 1:1.2 to 1:1.5 (ideal), max 1:2.0 (acceptable)
- Wohnküche: 1:1.0 to 1:1.8 (ideal, allows open plan)
- Bathrooms: 1:1.0 to 1:2.0
- Hallways: no ratio constraint (inherently narrow)

**Implementation:**
- Room proportion scoring already exists (`room_aspect_ratios`, lines 361-382 in optimizer.py) but uses a coarse 0.33/0.5 threshold
- Refine to: score = gaussian(aspect_ratio, ideal_ratio, sigma) per room type
- Add to fitness: `proportion_harmony` — how well the room system works as a whole (not just individual rooms)
- Generator change: Phase 6 room widths should target ideal ratios, not just minimum areas. When bay is wide enough, prefer 1:1.3 bedroom over maximizing Wohnküche.

### 2.4 — Hallway Efficiency

**Problem:** The distribution arm takes a fixed 1.10m slice regardless of apartment width. For wider apartments (2-bay, 3-bay), this wastes area. Circulation as % of total is not optimized.

**Targets:**
- 1-room apartment: 10-12% circulation (just entry hallway)
- 2-room: 12-15% (hallway + short distribution)
- 3-room: 15-18% (hallway + distribution arm)
- 4/5-room: 16-20% (longer distribution arm)

**Implementation:**
- Make `dist_arm_d` variable (0.90m to 1.30m) based on apartment type and width
- Add optimizer gene: `distribution_arm_depth: float` (0.0-1.0 → maps to 0.90-1.30m)
- Refine `circulation_efficiency` fitness criterion (already exists, lines 332-359) with per-apartment-type targets instead of a single 12-18% range
- Generator: for 2-room apartments, skip distribution arm entirely if both rooms connect directly to the hallway

### Files affected (all of Phase 2)

| File | Change |
|------|--------|
| `goldbeck_generator.py` | Solar-aware room assignment, variable distribution arm |
| `optimizer.py` | New acoustic criterion, refined proportions, hallway efficiency |
| `quality_scoring.py` | Acoustic adjacency analysis, proportion harmony |
| `goldbeck_constants.py` | Ideal room ratios, acoustic adjacency penalty matrix |
| `models/floorplan.py` | `building_orientation_deg` on FloorPlanRequest |
| `models/optimization.py` | New chromosome genes |

### Estimated scope

Backend: ~400 lines new/modified across 5 files
No frontend changes (scores appear automatically in fitness breakdown)

---

## Phase 3: Interactive Plan Editor

### 3.0 — Full Viewport Layout

**Problem:** The viewer is hardcoded at 900×600px inside a tab alongside other content. Floor plans deserve a dedicated section.

**Change:**
- Floor plan viewer becomes a responsive full-width section
- Remove hardcoded width/height — use container dimensions
- Canvas scales to fill available space with proper DPI handling
- Sidebar (apartment details) overlays or slides in from the right
- Floor selector becomes a persistent strip at the top of the section
- Building selector (when multiple buildings) as a top bar

### 3.1 — Architectural Drawing Conventions

**Problem:** Walls are colored rectangles. Windows and doors lack standard symbols. The plan doesn't look like an architectural drawing.

**Changes:**
- Bearing walls: filled solid dark, 24cm at scale
- Partition walls: double-line with hatch, 10cm at scale
- Exterior walls: thick outer line, inner line
- Doors: standard arc symbol (90° swing), direction indicator
- Windows: double-line with center line (German convention)
- Wet rooms: light blue fill with subtle diagonal hatch
- Staircase: stair lines with up/down arrows
- Balcony: dashed outline (indicates exterior element)
- Elevator: crossed-box symbol

### 3.2 — Dimension System

**Interactive dimensions:**
- Bay widths along top edge (always visible)
- Building depth along left edge (always visible)
- Room dimensions on hover/select (width × depth + area)
- Wall-to-wall measurements between clicked points (measurement tool already exists)
- Structural grid axis labels (A, B, C... and 1, 2, 3...)
- Running dimensions along exterior walls

### 3.3 — Layer Controls

Toggle visibility of:
- [ ] Structural grid + axis labels
- [ ] Room labels + areas
- [ ] Dimension lines
- [ ] Doors + windows
- [ ] Balconies
- [ ] Wall fills (solid/hatch)
- [ ] Color coding (by room type / by apartment)
- [ ] Furniture zones (optional ghost furniture)

### 3.4 — Dual Mode (Architect / Presentation)

**Architect mode:**
- All dimensions, grid lines, wall thicknesses
- Technical color scheme (grays, minimal color)
- Scale bar, north arrow, title block
- Measurement tool active
- Click any element for properties panel

**Presentation mode:**
- Clean room type colors (warm palette)
- Large room labels with areas
- Apartment outlines with unit numbers
- No grid lines, no wall details
- Legend with room type colors
- Ideal for client meetings and investor decks

### 3.5 — Element Inspection (Read-Only Interaction)

Before full editing, build the selection/inspection layer:
- Click a room → sidebar shows: room type, area, dimensions, apartment, DIN compliance
- Click a wall → sidebar shows: wall type, thickness, bearing status, length
- Click a window → sidebar shows: width, height, sill height, floor-to-ceiling flag
- Click a door → sidebar shows: width, swing direction, entrance flag
- Click an apartment → highlight all rooms, show total area, unit mix type, compliance status
- Hover: subtle highlight + tooltip with key info

### 3.6 — Interactive Editing

This is the biggest feature. Build incrementally:

**3.6a — Partition wall dragging**
- Drag a partition wall to resize two adjacent rooms
- Constrain to structural grid (snap to 62.5cm increments)
- Validate: both rooms stay above DIN minimums
- Visual feedback: real-time area display while dragging
- Red highlight if constraint would be violated

**3.6b — Apartment boundary adjustment**
- Drag an apartment boundary (bearing wall overlap) to reassign bays
- This changes which bays belong to which apartment
- Rooms regenerate automatically within new boundaries
- Constraint: bay must belong to exactly one apartment

**3.6c — Door and window manipulation**
- Click a door → drag along wall to reposition
- Click a window → drag to reposition, resize handles for width
- Add new door/window: select wall → place element
- Delete: select element → delete key
- Constraint: minimum edge distances, maximum span between openings

**3.6d — Room type reassignment**
- Click a room → change its type (bedroom ↔ living ↔ kitchen)
- Automatically updates apartment classification (2-room → 3-room if bedroom added)
- Validation: must still meet DIN requirements for the new type

**3.6e — Real-time validation overlay**
- As edits happen, validation runs continuously
- Green/yellow/red indicators per room and per apartment
- Violation tooltips: "Bedroom 2 area 9.2m² < 10m² minimum"
- Building-level warnings: "Fire egress distance exceeded for apt B03"

### 3.7 — Change Persistence

Edits need to feed back into the data model:
- Edited floor plans stored as `user_overrides` on the FloorPlan model
- Override format: `{ room_id: { polygon: [...], room_type: "..." }, wall_id: { position: ... } }`
- When optimizer re-runs, user overrides can be preserved or cleared (user choice)
- Export (IFC, PNG) uses the edited version
- Undo/redo stack (Ctrl+Z / Ctrl+Y) — at least 20 steps

### Files affected (all of Phase 3)

| File | Change |
|------|--------|
| `floor-plan-viewer.tsx` | Complete rewrite — responsive, layers, dual mode, editing |
| `floor-plan-panel.tsx` | Full-viewport layout, layer controls, mode toggle |
| `floor-plan-editor.tsx` | New: editing logic, drag handlers, constraint validation |
| `floor-plan-dimensions.tsx` | New: dimension line rendering system |
| `floor-plan-toolbar.tsx` | New: mode toggle, layer toggles, measurement tool |
| `apartment-detail.tsx` | Enhanced: element properties panel |
| `models/floorplan.py` | Add `user_overrides` to FloorPlan model |
| `validation.py` | Expose per-room and per-apartment validation for real-time use |

### Estimated scope

Frontend: ~2000-3000 lines across 6-8 files (largest phase)
Backend: ~200 lines (validation API, override model)

---

## Phase 4: Advanced Features (Future)

These build on Phases 1-3 and can be prioritized later:

- **Furniture feasibility overlay** — Ghost furniture placement in rooms showing standard layouts fit
- **DIN A3 PDF export** — Publication-quality architectural drawings with proper title blocks
- **Multi-building coordination** — Shared parking, access roads, green space between buildings
- **Thermal envelope analysis** — U-value estimates per facade, energy class prediction
- **Cost estimation integration** — Per-unit and per-m² construction cost from Goldbeck system catalog
- **BIM coordination** — Enhanced IFC export with MEP routing, clash detection preparation

---

## Recommended Implementation Order

```
Week 1-2:  Phase 1 (Per-floor generation)
           └─ This unblocks everything else

Week 3-4:  Phase 2 (Generation intelligence) ──┐
           Phase 3.0-3.2 (Viewport + drawing)──┤ parallel tracks
                                                │
Week 5-6:  Phase 3.3-3.5 (Layers, modes, inspection)
           Phase 2 continued (testing + tuning)

Week 7-9:  Phase 3.6 (Interactive editing)
           └─ Most complex, needs solid foundation

Week 10:   Phase 3.7 (Persistence + undo/redo)
           Integration testing across all phases
```

Total estimated effort: ~10 weeks for one developer working full-time, or longer part-time.

---

## Open Questions

1. **Ground floor commercial units** — Do we support Gewerbe (retail/office) on the ground floor? This changes the access type logic and unit mix substantially.
2. **Parking integration** — Should the generator consider Tiefgarage (underground parking) dimensions and column grid alignment with the structural grid?
3. **Multiple staircases** — The generator supports staircase count variation (+/-1). Should per-floor generation allow different staircase configurations, or must they always stack?
4. **User override granularity** — When the user edits a floor plan, should edits apply to all identical floors automatically, or per-floor individually?
5. **Performance budget** — Full per-floor generation with 4+ stories × 100 population × 100 generations = 40,000+ floor plan generations per optimization run. Need to confirm Railway timeout budget.

---

## Technical Risks

- **Optimizer performance**: Per-floor generation multiplies computation by `num_stories`. May need to optimize the generator (caching, partial evaluation) or reduce population/generations for multi-story buildings.
- **Canvas performance**: A full-viewport canvas with interactive editing, dimension lines, and real-time validation could struggle on lower-end machines. May need to move to SVG or WebGL for the editor layer.
- **Undo/redo complexity**: Tracking arbitrary edits to a deeply nested floor plan model requires a robust diffing strategy or command pattern.
- **Structural continuity validation**: Ensuring bearing walls stack across independently-generated floors adds a hard constraint to the optimizer that may reduce diversity.
