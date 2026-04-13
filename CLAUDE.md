# Memory

## Me
Adrian Krasniqi, architect/developer at a plus a studio L.L.C. Building a web-based residential floor plan optimizer for the Goldbeck precast concrete system.

## People
| Who | Role |
|-----|------|
| **Adrian** | Adrian Krasniqi — project owner, architect + developer |
→ Full list: memory/people/

## Terms
| Term | Meaning |
|------|---------|
| Ganghaus | Central corridor access, apartments both sides (depth ≥10m) |
| Laubengang | External gallery access (depth ≥6.25m) |
| Spaenner | Direct staircase access (narrow buildings) |
| Wohnküche | Combined living room + kitchen (no separate kitchen room) |
| Service strip | Hallway → TGA shaft → bathroom (corridor-side of apartment) |
| Distribution arm | 1.10m full-width hallway extension for 3+ room apartments |
| Staffelgeschoss | Setback top floor — doesn't count as Vollgeschoss |
| Schottwand | Goldbeck precast concrete wall system, 62.5cm grid |
| GRZ | Grundflächenzahl — ground coverage ratio |
| GFZ | Geschossflächenzahl — floor area ratio |
| IFC | Industry Foundation Classes — BIM exchange format |
| Raster | Bay width in the structural grid (e.g. 3.75m, 5.00m) |
| TGA | Technische Gebäudeausrüstung — building services (MEP) |
→ Full glossary: memory/glossary.md

## Active Project
| Name | What |
|------|------|
| **Goldbeck Optimizer** | Web-based floor plan optimizer for Goldbeck precast system. Genetic algorithm generates apartment layouts with IFC export + Rhino sync |
→ Details: memory/projects/goldbeck-optimizer.md

## Session Protocol
**IMPORTANT — follow this every session:**
1. **On session start:** Read this file + any relevant `memory/` files
2. **Before starting work:** Update "Last Request" below with Adrian's prompt and set status to `IN PROGRESS`
3. **After completing work:** Update "Last Request" status to `DONE`, update "Recently completed" and "Known issues", update `memory/projects/goldbeck-optimizer.md` session history
4. **If the next session sees status = `IN PROGRESS`:** The previous session was cut off. Read the request, check what was partially done (git diff, file state), and resume.

## Last Request
**Status:** DONE
**Date:** 2026-04-13
**Request:** Implement Phase 1 — Per-floor independent generation
**Progress:** Full Phase 1 implementation complete. Per-floor independent generation with ground floor differentiation, Staffelgeschoss tagging, optimizer per-floor genes, and all-floor fitness evaluation. See details in "Recently completed" below.

## Current State
**Last updated:** 2026-04-13

### Recently completed
- **Phase 1: Per-floor independent generation** (2026-04-13):
  - Added `FloorType` enum (ground/standard/staffelgeschoss) and `FloorConfig` model to `models/floorplan.py`
  - Added `enable_per_floor`, `floor_configs`, `ground_floor_barrier_free` fields to `FloorPlanRequest`
  - Refactored `generate_floor_plans()` — phases 1-4 (grid, access, staircases) shared for structural continuity; phases 5-7 (allocation, rooms, elements) run independently per floor
  - Ground floor forces barrier-free bathrooms (BauO NRW §50) and exterior entrance doors
  - Staffelgeschoss tagged with `FloorType.STAFFELGESCHOSS` in the per-floor loop
  - Extended `FloorPlanChromosome` with per-floor genes: `floor_allocation_orders`, `floor_service_orders`, `floor_proportion_offsets` (8 floors max)
  - `to_variation_params()` emits `floor_variation_params` dict for per-floor overrides
  - Extracted `_evaluate_single_floor()` from `_evaluate_floor_plan()` — fitness now averages all 17 criteria across ALL floors
  - Updated crossover and mutation to handle per-floor genes
  - Frontend: added `FloorType` to TS types, floor selector shows "SG" for Staffelgeschoss
  - Files changed: `models/floorplan.py`, `goldbeck_generator.py`, `optimizer.py`, `types/api.ts`, `floor-plan-panel.tsx`
  - Tests: 30 pass (2 pre-existing failures from stale `VALID_RASTERS` constant reference)
  - Functional tests confirm: different floors get different apartment layouts when per-floor variation params differ
- **Room/window overflow fix** (2026-04-13):
  - Root cause: DIN 18011 minimum bedroom widths could exceed apartment bay width, pushing Wohnküche and windows past building boundary
  - Fixed 3-room apartments: cascading shrink (bed2 → bed1 → liv_w) instead of broken scale-then-max-back
  - Fixed 2-room apartments: bedroom width clamped so living room always fits
  - Fixed 4/5-room apartments: hard clamp per bedroom + early break if <1m remains
  - Added universal safety clamp: all room polygons (except balconies) clamped to apartment bounding box after generation
  - Added window position clamping: windows clamped to both building envelope and room boundaries
  - File changed: `services/floorplan/goldbeck_generator.py` (+63 lines, -4 lines)
  - Commit: `7ff1507` — pushed to origin/main
- **Optimizer default fix** (2026-04-13):
  - Frontend `optimization-preferences.tsx` defaulted population_size=500, but backend max is 200 (Pydantic `Field(le=200)`)
  - Changed defaults from 500 to 100 for both generations and populationSize
  - Commit: `c11f7db` — pushed to origin/main
- **Implementation plan created** (2026-04-13):
  - Full plan in `IMPLEMENTATION_PLAN.md` at project root
  - Phase 1: Per-floor independent generation (foundation)
  - Phase 2: Generation intelligence (solar, acoustic, proportions, hallway efficiency)
  - Phase 3: Interactive plan editor (full viewport, dual mode, wall dragging, real-time validation)
  - Phase 4: Advanced features (furniture overlay, PDF export, cost estimation)
  - Adrian chose: full per-floor generation, all 4 quality factors, dual-mode viewer (architect + presentation), full plan editor
- **Cadastral parcel fix** (2026-04-12): Deployed — BKG disabled, Berlin URLs updated, timeouts reduced
- **Validation suite**, **optimizer convergence overhaul**, **100-issue audit** — all previously completed

### Known issues / next up
- **CI frontend always failing** — `pnpm-lock.yaml` out of sync with `package.json`. Lockfile verified in sync locally; may need commit + push to fix CI.
- **Phase 1 uncommitted** — All changes are local. Need to commit + push when ready.
- **Start Phase 2** — Generation intelligence (solar, acoustic, proportions, hallway efficiency). See `IMPLEMENTATION_PLAN.md`.
- **Stale test constants** — 2 tests reference `C.VALID_RASTERS` which was renamed to `STANDARD_RASTERS`. Quick fix.
- After deploy: hit `/api/v1/cadastral/diagnostics/wfs-health` to verify state WFS endpoints from Railway
- Optimizer changes need real-world testing (run on actual parcel + compare before/after)
- Rhino plugin code exists but is NOT YET COMPILED (needs VS2022 + .NET 4.8 + Rhino 8 SDK)

## Preferences
- Continue without asking questions when resuming from a session summary
- German UI text where user-facing (Flurstück, Platzhalter, etc.)
- Push to GitHub only when explicitly asked

---

# Project Architecture

## Quick Start
```bash
# Backend (MUST run from backend/ directory)
cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend
pnpm dev
```

## Backend (`/backend/app/`)
- **Generator**: `services/floorplan/goldbeck_generator.py` — 7-phase deterministic layout engine
- **Optimizer**: `services/floorplan/optimizer.py` — Genetic algorithm, 17-criterion fitness
- **Quality Scoring**: `services/floorplan/quality_scoring.py` — 5 advanced architectural criteria
- **Constants**: `services/floorplan/goldbeck_constants.py` — All Goldbeck system dimensions
- **Rules**: `services/floorplan/architectural_rules.py` — Building code validation
- **IFC Export**: `services/ifc_exporter.py` — IFC 2x3 with IfcOpeningElement void cutting
- **Cadastral**: `services/cadastral.py` — 16-state parcel lookup (Nominatim + WFS + Overpass + synthetic)
- **Regulations**: `services/german_regulations.py` — German building code parameters
- **WebSocket**: `services/ws_sync.py` — Live-sync broadcaster for Rhino/GH
- **Models**: `models/floorplan.py` — All Pydantic data models

## Frontend (`/frontend/`)
- React/TypeScript with Three.js 3D building viewer
- `components/three/building-detailed.tsx` — 3D renderer with geometric wall matching
- `components/floorplan/floor-plan-viewer.tsx` — 2D canvas floor plan renderer
- `components/map/cadastral-map.tsx` — Mapbox GL map with parcel selection
- `hooks/use-floor-plan.ts` — Generation hook (passes Staffelgeschoss flag)
- `hooks/use-cadastral.ts` — Cache-first parcel loading with radius search

## Rhino Plugin (`/rhino-plugin/`)
- C# GHA plugin (NOT YET COMPILED) — WebSocket client + BRep geometry builder
- See `BUILD.md` for architecture and build instructions

## Key Technical Notes
- Backend must run from `/backend/` dir or you get ModuleNotFoundError
- Don't use `--reload` during optimization (causes job loss)
- CORS configured for ports 3000-3002 on localhost and 127.0.0.1
- `BuildingFloorPlans.building_width_m` = generator's `length_m` (long facade)
- `BuildingFloorPlans.building_depth_m` = generator's `depth_m` (short dimension)
- Plan coords (x, y) → Three.js (x, y_up, -y_plan). Wall rotation uses `angle` not `-angle`
- Per-floor `StructuralGrid` has own `building_length_m`, `building_depth_m`, `origin` for Staffelgeschoss
- Bay widths: 3.125, 3.75, 4.375, 5.00, 5.625, 6.25m
- IFC walls placed at `wall.start` with local X along wall direction, profiles extruded along Z
