# Goldbeck Wohngebäude Floor Plan Optimizer

**Status:** Active, in development
**Owner:** Adrian Krasniqi (a plus a studio L.L.C.)
**Repo:** https://github.com/gipaperpipa/goldbeck-optimizer.git

## What It Is
Web-based residential floor plan optimizer for the Goldbeck precast concrete system (Schottwand, 62.5cm grid). An evolutionary/genetic algorithm generates optimized apartment layouts. Outputs include IFC export for BIM workflows and real-time Rhino/Grasshopper sync via WebSocket.

## Tech Stack
- **Backend:** Python, FastAPI, uvicorn
- **Frontend:** React, TypeScript, Next.js, Three.js, Mapbox GL
- **BIM:** IFC 2x3 (ifcopenshell), Rhino 8 plugin (C#/.NET 4.8, not yet compiled)
- **Cadastral:** Nominatim, German state WMS/WFS, Overpass API

## Architecture
- 7-phase deterministic generator: grid snap → access type → structural grid → staircases → apartment allocation → room layouts → walls/doors/windows
- Genetic algorithm optimizer with 17-criterion fitness function + 5 advanced quality scores
- Cadastral service: 4-strategy cascade (Nominatim → WFS → Overpass → synthetic) covering all 16 German states
- Real-time visualization during optimization (live best layout updates)

## Session History

### Session 1 (initial)
- Initial project setup and architecture

### Session 2 (2026-03-24)
Addressed 7 major issues:
1. ✅ Fixed `grid.axis_positions_y is not iterable` crash
2. ✅ Made GRZ/GFZ editable input fields
3. ✅ Fixed overlapping building layouts (discarded by optimizer)
4. ✅ Added real-time generation visualization
5. ✅ Fixed 2D floor plan viewer (wall-oriented windows/doors, unit_number fix)
6. ✅ Fixed 3D viewer (wall rotation sign bug)
7. ✅ Implemented Staffelgeschoss (setback top floor with full pipeline)
8. ✅ Improved cadastral parcel coverage (4-strategy cascade)

### Session 3 (2026-03-24, continuation)
- Continued cadastral coverage: added Overpass API fallback + synthetic rectangular parcel
- Added visual distinction for synthetic parcels (amber dashed outline, German warning label)
- All backend Python files verified (ast.parse)
- Committed all changes (22 files, 3640 insertions)
- Git push failed from sandbox (403 credentials) — needs push from local machine
- Cadastral hook updated externally: now has cache-first loading, radius search, DB id support

## Known Issues
- **Fitness flatline:** Optimizer still flatlines in early generations. Adaptive mutation was added but may be insufficient. Needs investigation — possibly tournament selection, elitism tuning, or diversity preservation.
- **Rhino plugin:** Code exists but NOT compiled. Requires VS2022 + .NET 4.8 + Rhino 8 SDK.
- **Git push:** Sandbox can't push to GitHub (no credentials). Must push from local machine.

## Key Files (most frequently edited)
| File | What |
|------|------|
| `backend/app/services/floorplan/goldbeck_generator.py` | 7-phase generator + Staffelgeschoss |
| `backend/app/services/floorplan/optimizer.py` | Genetic algorithm |
| `backend/app/services/cadastral.py` | 4-strategy parcel lookup |
| `backend/app/services/ifc_exporter.py` | IFC 2x3 export |
| `backend/app/models/floorplan.py` | All Pydantic data models |
| `frontend/src/components/three/building-detailed.tsx` | 3D viewer |
| `frontend/src/components/floorplan/floor-plan-viewer.tsx` | 2D viewer |
| `frontend/src/components/map/cadastral-map.tsx` | Cadastral map |
| `frontend/src/hooks/use-floor-plan.ts` | Generation hook |
| `frontend/src/hooks/use-cadastral.ts` | Parcel hook (cache-first) |
| `frontend/src/types/api.ts` | TypeScript API types |
