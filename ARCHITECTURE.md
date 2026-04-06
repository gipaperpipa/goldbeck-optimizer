# Architecture Overview

## System Diagram

```mermaid
graph TB
    subgraph Frontend["Frontend (Next.js / React)"]
        UI[Project Wizard UI]
        Map[Cadastral Map<br/>Mapbox GL]
        FPV[2D Floor Plan Viewer<br/>Canvas]
        S3D[3D Building Scene<br/>Three.js / R3F]
        Opt[Optimization Panel]
    end

    subgraph Backend["Backend (FastAPI / Python)"]
        API[REST API<br/>/api/v1/*]
        WS[WebSocket<br/>/ws/sync]
        subgraph Generator["Floor Plan Engine"]
            Gen[7-Phase Generator<br/>goldbeck_generator.py]
            GA[Genetic Algorithm<br/>optimizer.py]
            Fit[17-Criterion Fitness<br/>quality_scoring.py]
            Rules[Building Code Rules<br/>architectural_rules.py]
        end
        Cad[Cadastral Service<br/>16 German states]
        IFC[IFC Exporter<br/>IFC 2x3]
        PS[Parcel Store<br/>SQLite cache]
    end

    subgraph External["External Services"]
        Nom[Nominatim<br/>Geocoding]
        WFS[State WFS/WMS<br/>Parcel data]
        OSM[Overpass API<br/>Fallback]
    end

    subgraph Rhino["Rhino / Grasshopper (optional)"]
        GH[GH WebSocket Client]
        BRep[BRep Builder]
    end

    UI --> API
    Map --> API
    Opt --> API
    API --> Gen
    API --> GA
    GA --> Gen
    GA --> Fit
    Gen --> Rules
    API --> Cad
    API --> IFC
    Cad --> PS
    Cad --> Nom
    Cad --> WFS
    Cad --> OSM
    WS --> GH
    S3D --> API
```

## Data Flow

1. **Plot Selection** — User selects parcels on the cadastral map. Parcels are fetched via a cache-first strategy: SQLite DB → WFS → Overpass → synthetic rectangle.

2. **Optimization** — User configures unit mix and weights, then starts the genetic algorithm. The GA evolves chromosomes encoding bay preferences, access type, room proportions, and staircase placement. Each chromosome is decoded by the 7-phase generator and scored by 17 fitness criteria.

3. **Visualization** — Results render in both 2D (canvas floor plans) and 3D (Three.js building scene with walls, windows, doors). Users can export to IFC or sync live to Rhino/Grasshopper via WebSocket.

## Generator Pipeline (7 Phases)

| Phase | Name | Input | Output |
|-------|------|-------|--------|
| 1 | Snap to Grid | Raw dimensions | Grid-aligned dimensions (62.5cm) |
| 2 | Select Access | Dimensions | Access type (Ganghaus/Laubengang/Spaenner) |
| 3 | Build Grid | Dimensions + access | StructuralGrid with bay widths and zones |
| 4 | Place Staircases | Grid | Staircase positions at legal bay boundaries |
| 5 | Allocate Apartments | Grid + stairs | Apartment slots per zone |
| 6 | Generate Rooms | Apartment slots | Room geometries (service strip → living) |
| 7 | Generate Elements | Rooms | Walls, doors, windows with openings |

## Key Directories

```
backend/
  app/
    api/v1/          # REST endpoints
    models/          # Pydantic data models
    services/
      floorplan/     # Generator + optimizer + rules
      cadastral.py   # 16-state parcel lookup
      ifc_exporter.py
      ws_sync.py     # Rhino live-sync
    database/        # SQLite engine + parcel store

frontend/
  src/
    app/             # Next.js pages (project wizard)
    components/
      three/         # 3D scene (R3F)
      floorplan/     # 2D floor plan canvas
      map/           # Cadastral Mapbox map
      optimization/  # GA controls + fitness chart
    hooks/           # useCadastral, useFloorPlan, useOptimization
    stores/          # Zustand state management
    types/           # API type definitions
```
