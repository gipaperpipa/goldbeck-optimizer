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
**Status:** DONE — awaiting git push to deploy
**Date:** 2026-04-12
**Request:** Fix cadastral parcel selection — always returning synthetic placeholders instead of real parcels
**Progress:** Root-caused: BKG federal WFS doesn't exist (ERROR_UNKNOWN_SERVICE), Berlin WFS migrated to gdi.berlin.de (old URL 404), timeout budget exceeded Railway's 30s limit. Fixed all three issues + added diagnostics endpoint. Verified Berlin WFS returns real GeoJSON. Changes need `git push` from local machine to deploy.

## Current State
**Last updated:** 2026-04-12

### Recently completed
- **Cadastral parcel fix** (2026-04-12):
  - Disabled BKG federal WFS (service doesn't exist — wasted timeout budget)
  - Updated Berlin WFS/WMS from fbinter.stadt-berlin.de → gdi.berlin.de (old URLs return 404/503)
  - Berlin typename: `alkis_flurstuecke:flurstuecke` (verified via GetCapabilities + GetFeature)
  - Reduced httpx timeouts: 10s per-request, 20s hard cap on concurrent gather, 15s on radius fetch
  - Reduced WFS format attempts from 4 to 2 (JSON + GML only)
  - Added `/diagnostics/wfs-health` endpoint to test all 16 state WFS/WMS endpoints
  - Accept best-available polygon even if click point isn't perfectly inside
  - Files changed: `services/cadastral.py`, `services/parcel_store.py`, `api/v1/cadastral.py`, `hooks/use-cadastral.ts`
- **Production-readiness fixes** (deployment prep):
  - `config.py`: debug defaults to `false` (was hardcoded `true`)
  - `railway.toml`: start command activates venv (was missing)
  - `Dockerfile`: uses `$PORT` env var, creates `data/` dir
  - `database/engine.py`: supports `DATABASE_URL` and `DB_DIR` env vars
  - `DEPLOY.md`: added ephemeral storage notes, new env vars table
- **Validation suite** (`services/floorplan/validation.py`): 11 building code checks
  1. DIN 18011 room sizes (area + minimum short-side dimension)
  2. Room aspect ratios (max 1:3 for habitable rooms)
  3. Door widths (entrance ≥ 0.90m, interior ≥ 0.80m, BF ≥ 0.90m)
  4. Fire egress (worst-point distance to staircase, not centroid)
  5. DIN 5034 window-to-floor ratio (≥ 12.5% for habitable rooms)
  6. Daylight access (habitable rooms must touch exterior wall)
  7. Apartment entrance integrity (exactly 1 entrance door + hallway)
  8. Structural grid compliance (bay widths in valid Goldbeck rasters)
  9. Apartment area compliance (within Goldbeck spec ranges)
  10. Bathroom stacking (vertical alignment across floors)
  11. Service strip connectivity (hallway ↔ bathroom adjacency)
- **Validation API**: `POST /api/v1/floorplan/validate` endpoint
- **Auto-validation**: every optimizer variant now includes validation results
- **Test harness**: `scripts/run_validation.py` with 7 building scenarios
- **Optimizer convergence overhaul** (6 fixes — see session history)
- **Diagnostic scripts**: `diagnose_optimizer.py` + `run_validation.py`
- Full 100-issue audit completed (AUDIT.md)

### Known issues / next up
- **Git push needed** — cadastral fix is local only, needs `git push` from local machine to deploy on Railway/Vercel
- After deploy: hit `/api/v1/cadastral/diagnostics/wfs-health` to see which of 16 state WFS services are reachable from Railway
- After deploy: test parcel selection in Chrome for Berlin, NRW, Bayern to confirm real parcels load
- Some state WFS URLs may have moved (like Berlin did) — diagnostics endpoint will reveal which
- Optimizer changes need real-world testing (run on actual parcel + compare before/after)
- Validation needs to be run locally to find systematic generator issues
- Rhino plugin code exists but is NOT YET COMPILED (needs VS2022 + .NET 4.8 + Rhino 8 SDK)
- Financial model conversation started on Machine B but no details shared yet

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
