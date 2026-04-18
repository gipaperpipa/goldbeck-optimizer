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
**Date:** 2026-04-18
**Request:** Phase 3.6c — Door and window manipulation
**Progress:** New "Openings" edit mode added to the viewer toolbar. Doors & windows become selectable, drag along host wall with 6.25cm snap, windows get amber resize handles at each edge, Delete/Backspace removes the selected opening. Validation rejects drops that collide with another opening on the same wall, come too close to the wall end (<15cm), or fall outside window width range [0.60m, 4.00m]; invalid drop reverts to pre-drag snapshot with a red ghost + reason label. Typecheck + lint + build all clean.

## Current State
**Last updated:** 2026-04-18

### Recently completed
- **Phase 3.6c: Door & window manipulation** (2026-04-18):
  - New "Openings" edit-mode toolbar button (sky-blue when active) — mutually exclusive with "Edit" (wall) mode. Each opening-edit session draws soft sky-blue dashed halos around every door/window in the plan as a grabbability hint; hover strengthens the halo.
  - Hit-test: `openingAtPoint()` projects the cursor onto the opening's host wall axis (identified via the existing `findNearestWall2D`) and checks along-axis distance ≤ `width/2` + perpendicular distance ≤ 0.30m. Windows take priority over doors (mirrors the read-only inspection handler).
  - Selection + move: mousedown on an opening selects it (amber ring appears) and starts a move drag. The cursor position is clamped to the host wall's interior `[wallMin + 0.15, wallMax - 0.15]m` (15cm `MIN_OPENING_EDGE_M`), and snapped to 6.25cm (`OPENING_SNAP_M` = 1/10 of the Goldbeck grid) for smooth but precise positioning.
  - Window resize: selected windows get two amber circular resize handles at their along-axis edges. Dragging a handle holds the window's center fixed and moves one edge. Width is clamped to `[0.60m, 4.00m]` and to the available interior space.
  - Collision: other openings on the same host wall pre-populate a `forbidden: [min, max][]` list (including a `MIN_OPENING_GAP_M = 0.10m` padding). Any drag that produces an opening interval intersecting a forbidden interval fails validation; the overlay tints red and the reason label reads "Kollision mit anderer Öffnung".
  - Delete: with an opening selected and no active drag, `Delete` / `Backspace` removes it from `editedPlan`. (The existing Reset button restores the server copy, including deleted openings.)
  - Pure application helper: `applyOpeningDragOnPlan(basePlan, drag, alongCursor, snap)` returns the next plan + new position + width + valid flag + reason string. Matches the wall-drag pattern — module-scope, takes the pre-drag snapshot as `basePlan` so drag state never references stale live plan.
  - Overlay: `drawOpeningEditOverlay()` renders (1) soft halo on every opening, (2) brighter halo on hover, (3) amber selection ring + resize handles for the selected window, (4) green (valid) / red (invalid) drag ghost with a reason label positioned above the opening. Footer hint text explains the controls when nothing is selected.
  - Esc priority in opening mode: cancel active drag → deselect → exit opening mode.
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~410 lines)
  - Typecheck clean; `next build` green; lint back to pre-existing 4 issues (0 introduced).
  - Still pending: 3.6d room relabeling, 3.6e real-time per-apartment validation, 3.7 persistence + undo/redo.
- **Phase 3.6b: Apartment boundary adjustment** (2026-04-18):
  - Wall classification: new `getWallDragKind()` runtime classifier checks whether rooms on opposite sides of a wall belong to different apartments — returns `"apt_boundary"` for bearing_cross walls between apartments, `"partition"` for the 3.6a case. (Backend emits `WallType.BEARING_CROSS` split at the Ganghaus corridor, not `APT_SEPARATION` — so the separator is detected geometrically.)
  - Wall grouping: `startWallDrag` groups all co-axis `bearing_cross` segments (the north/south halves split by the corridor) into `affectedWallIds` so the whole apartment boundary translates as one during a drag.
  - Axis snapping: `snapForDrag` replaces 3.6a's `snapToGrid`. For `apt_boundary` + x-axis drags, snaps to the nearest interior `grid.axis_positions_x` entry (excluding the building endpoints). Partition drags keep the 62.5cm grid snap.
  - Validation: `applyWallDragOnPlan` now returns an `invalidReason` string. For apt_boundary kind, each touched apartment's span is recomputed from its rooms' min/max X and rejected if `< MIN_APARTMENT_WIDTH_M` (3.125m = one bay). DIN room-minimum check stays on top.
  - Visual palette: apt boundaries render amber (`#f59e0b66` base / `#f59e0b` hover / `#b45309` active) vs partitions emerald from 3.6a. Drag label shows "Apt-Grenze" vs "Trennwand" and surfaces `invalidReason` on failure.
  - Pre-drag safety pad: kind-aware — 1.0m for partition, 3.125m for apt_boundary so the clamp range never forces a sub-bay width.
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~250 lines)
  - Typecheck clean; `next build` green; lint back to pre-existing 4 issues (0 introduced).
  - Still pending: 3.6c door/window manipulation, 3.6d room relabeling, 3.6e real-time per-apartment validation overlay, 3.7 persistence + undo/redo.
- **Phase 3.6a: Partition wall dragging** (2026-04-18):
  - Edit-mode toggle added to the viewer toolbar (emerald button). While active, every draggable partition wall (`wall_type === "partition"`, non-bearing, non-exterior) renders with a dashed emerald hint; hover strengthens it and shows an `ew-resize`/`ns-resize` cursor.
  - Drag hit-test: axis-classifies the wall (horizontal vs vertical), identifies the rooms whose polygon vertices sit exactly on that wall (left-side max-edge or right-side min-edge within 5cm tolerance), and computes a `minPos`/`maxPos` clamp from the neighboring rooms' far edges with a 1.0m safety pad.
  - Live preview applies the drag against a pre-drag snapshot (stored in a ref) on every mousemove: wall start/end updated, affected room polygon vertices translated, `area_sqm` recomputed via shoelace formula. Position snaps to the Goldbeck 62.5cm grid (`GRID_UNIT_M = 0.625`).
  - Validation checks each affected room's area against `MIN_ROOM_AREA_SQM` (mirror of `ApartmentRules.MIN_ROOM_AREAS` in the backend: living 14.0, bedroom 8.0, kitchen 4.0, bathroom 2.5, hallway 1.5, storage 0.5). On violation the overlay switches to red + room area badge shows `< {min}` instead of the green checkmark.
  - Mouseup commits the drag if valid + the wall actually moved; otherwise reverts to the snapshot. Esc cancels an active drag, exits edit mode, or deselects (priority in that order). Mouse-leave auto-commits to avoid orphaned drag state.
  - A Reset button appears once the edited plan diverges from the server copy, one-click restore. New plan from props (via `floorPlan !== lastSyncedPlan` render-time check) auto-resets local edits.
  - Internal refactor: `floorPlan` prop renamed to `plan` alias throughout interaction + drawing paths; `plan` reads from new `editedPlan` state. Prop is never mutated.
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~320 lines)
  - Typecheck clean; `next build` green; lint back to pre-existing 4 issues (0 introduced).
  - Still pending: 3.6b apartment boundary adjustment, 3.6c door/window manipulation, 3.6d room relabeling, 3.6e real-time validation overlay, 3.7 persistence + undo/redo.
- **Phase 3.0–3.5: Viewer upgrade** (2026-04-17):
  - **3.0 Full viewport** — viewer now fills available viewport via `ResizeObserver`; sidebar scrolls independently alongside, stacks below at <lg. Commit `345fbd9`.
  - **3.1 Drawing conventions** — DIN 1356: exterior bearing walls solid black, interior bearing get diagonal poché hatch, non-bearing partitions light fill + outline. Windows redrawn with two parallel wall-face lines + centered glass line + jamb caps + interior sill tick. Doors drawn at 90° open position with quarter-circle swing, hinge dot, jamb lines. Commit `6757603`.
  - **3.2 Dimensions** — DIN 406 two-string system: inner per-bay widths with 45° tick slashes, outer overall dimension with bold label + end ticks, extension lines from building edge. Pixel-based offsets so strings fit in the 50px padding at any zoom. Commit `6ee1257`.
  - **3.3 Layer controls** — Layers dropdown toggles grid/rooms/walls/openings/labels/dimensions/annotations. Each draw step gated on its flag. Commit `9bdeedb`.
  - **3.4 Dual mode** — Architect/Presentation segmented toggle. Architect: all layers on, soft bg, drop shadow, thick outline. Presentation: grid + dims off, pure white, no shadow, slim outline. Commit `e879367`.
  - **3.5 Element inspection** — Click priority: windows → doors → walls → rooms. Inspector overlay (bottom-left) shows type-specific properties. Apartment sidebar selection still fires alongside room clicks. Commit `7b0cef9`.
  - Files changed: `frontend/src/components/floorplan/floor-plan-panel.tsx`, `frontend/src/components/floorplan/floor-plan-viewer.tsx`
  - TypeScript clean after every slice; no backend changes.
- **Phase 2: Generation intelligence** (2026-04-17):
  - **B.1 Solar awareness** — `evaluate_quality()` refactored from `BuildingFloorPlans` → single `FloorPlan + building_depth_m` (silent Phase 1 bug fix: per-floor avg was re-using Floor-0 quality). Ganghaus allocation now puts the "extra" (odd count) of each apartment type on the side that compass-faces south after `rotation_deg`.
  - **B.2 Acoustic zoning** — new `score_acoustic_zoning()` in `quality_scoring.py`: bedroom-to-bathroom intra-apt distance + bedroom-to-staircase distance. Wired into fitness as `acoustic`, weight 0.7 in livability.
  - **B.3 Smooth aspect ratios** — replaced the cliff at 0.5/0.33 with Gaussian `10*exp(-(r-ideal)²/2σ²)`. Per-room-type ideals in `goldbeck_constants.py`: LIVING 0.70, BEDROOM 0.65, KITCHEN 0.55, BATH 0.50; σ=0.18.
  - **B.4 Distribution-arm gene** — new `distribution_arm_depth: float` chromosome gene (1.10–1.50m range). Was hard-coded at 1.10m. Threaded through mutation/crossover/variation_params → `_layout_apartment_rooms`.
  - Files changed: `goldbeck_constants.py`, `goldbeck_generator.py`, `optimizer.py`, `quality_scoring.py`
  - Commits: `fd57302` (Phase 2), `ce82800` (test cleanup) — both pushed to origin/main
  - Tests: 67 pass, 1 unrelated pre-existing financial calculator failure
  - End-to-end smoke confirms: `acoustic` key in breakdown, `distribution_arm_depth` gene varies across chromosomes, smooth aspect scoring active
- **CI fix** (2026-04-17): `pnpm/action-setup@v4` bumped from version 9 to 10 — lockfile incompatibility was causing every recent CI failure. Commit `525797a`.
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
- **Phase 3.6 interactive editing (continued)** — 3.6a + 3.6b + 3.6c shipped (partition drag, apartment-boundary drag, door/window manipulation). Still to do: 3.6d room type reassign, 3.6e real-time per-apartment validation, 3.7 persistence + undo/redo. Each deserves its own session.
- **Wall-drag known limitation** — only handles axis-aligned walls shared by neighboring rooms. T-junctions (a wall ending mid-room) will find no match on one side; the single affected room translates its vertices fine but the wall may no longer meet the perpendicular wall exactly. For the current Goldbeck generator output this is non-issue (all partitions span corridor-to-corridor or gable-to-gable, all apt boundaries are full-building bearing_cross), but revisit if 3.6d introduces new wall topologies.
- **Apt boundary drag — openings don't follow** — doors/windows sitting on a dragged apt-boundary wall keep their original x-coord; they re-sit on the wall fine in most cases because bearing_cross drags are small (one bay) but a multi-bay drag may leave an opening orphaned. 3.6c now gives the user a manual fix (drag opening back onto the wall); long-term a "move openings with the wall" pass still belongs on the apt_boundary commit path.
- **Opening edit — no "add new" yet** — 3.6c covers move / resize (windows) / delete but not creation. The IMPLEMENTATION_PLAN 3.6c scope also mentions "Add new door/window: select wall → place element" which is deferred. Add-new would need a wall-selection UI + default width logic (1.20m window, 0.95m door) + auto-apartment-assignment for doors.
- **Opening edit — resize for doors** — Doors have a fixed width; only windows get resize handles. This matches BauO NRW practice (door widths are prescriptive: 0.875m standard, 0.95m barrier-free) but if the backend ever emits non-standard door widths we may need to expose it.
- **Rhino plugin still not compiled** — `.NET SDK` is not installed on this machine (only the runtime). `dotnet build` fails with "No .NET SDKs were found". User needs to install Visual Studio 2022 with .NET desktop workload, or the standalone .NET SDK, before the plugin can be built. BUILD.md has the one-line build command once SDK is present.
- **WFS health check from Railway** — After the next backend deploy, hit `/api/v1/cadastral/diagnostics/wfs-health` on the Railway URL to verify all 16-state endpoints are live. Not known locally — the URL is assigned by Railway.
- **Unrelated pre-existing test failure** — `test_financial_calculator.py::TestFinancialCalculatorZeroGuards::test_zero_total_dev_cost_edge` asserts `roi_pct == 0` but gets `-100.0` when there are zero units/revenue but nonzero debt service. Not related to floor plan work — separate fix.
- **Optimizer real-world validation** — Phase 2 criteria (acoustic, orientation, smooth aspect) are wired correctly and the GA explores them, but no head-to-head on a real parcel has been done yet. Nice-to-have, not blocking.

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
