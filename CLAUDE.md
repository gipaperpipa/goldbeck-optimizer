# Goldbeck Wohngebäude Floor Plan Optimizer

## What This Is
Web-based residential floor plan optimizer for the Goldbeck precast concrete system (Schottwand, 62.5cm grid). Evolutionary algorithm generates optimized apartment layouts with IFC export and real-time Rhino/Grasshopper sync.

## Quick Start
```bash
# Backend (MUST run from backend/ directory)
cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend
pnpm dev
```

## Architecture

### Backend (`/backend/app/`)
- **Generator**: `services/floorplan/goldbeck_generator.py` — 7-phase deterministic layout engine
- **Optimizer**: `services/floorplan/optimizer.py` — Genetic algorithm, 17-criterion fitness
- **Quality Scoring**: `services/floorplan/quality_scoring.py` — 5 advanced architectural criteria (connectivity, furniture, daylight, kitchen-living, orientation)
- **Constants**: `services/floorplan/goldbeck_constants.py` — All Goldbeck system dimensions
- **Rules**: `services/floorplan/architectural_rules.py` — Building code validation
- **IFC Export**: `services/ifc_exporter.py` — IFC 2x3 with IfcOpeningElement void cutting
- **WebSocket**: `services/ws_sync.py` — Live-sync broadcaster for Rhino/GH
- **Models**: `models/floorplan.py` — All Pydantic data models

### Frontend (`/frontend/`)
- React/TypeScript with Three.js 3D building viewer
- `components/three/building-detailed.tsx` — 3D renderer with geometric wall matching

### Rhino Plugin (`/rhino-plugin/`)
- C# GHA plugin (NOT YET COMPILED) — WebSocket client + BRep geometry builder
- See `BUILD.md` for architecture and build instructions

## Key Concepts
- **Ganghaus**: Central corridor, apartments both sides (depth ≥10m)
- **Laubengang**: External gallery access (depth ≥6.25m)
- **Spaenner**: Direct staircase access (narrow buildings)
- **Wohnküche**: Combined living room + kitchen (no separate kitchen room)
- **Service strip**: Hallway → TGA shaft → bathroom (corridor-side of apartment)
- **Distribution arm**: 1.10m full-width hallway extension for 3+ room apartments
- **Bay widths**: 3.125, 3.75, 4.375, 5.00, 5.625, 6.25m (standard rasters)

## Important Notes
- Backend must run from `/backend/` dir or you get ModuleNotFoundError
- Don't use `--reload` during optimization (causes job loss)
- CORS configured for ports 3000-3002 on localhost and 127.0.0.1
- The Rhino plugin code exists but needs VS2022 + .NET 4.8 + Rhino 8 SDK to compile
