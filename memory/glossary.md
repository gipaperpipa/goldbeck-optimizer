# Glossary

Workplace shorthand, acronyms, and internal language for the Goldbeck Optimizer project.

## German Building Terms
| Term | Meaning | Context |
|------|---------|---------|
| Ganghaus | Central corridor access type | Apartments on both sides, building depth ≥10m |
| Laubengang | External gallery access type | Single-loaded corridor, depth ≥6.25m |
| Spaenner | Direct staircase access type | Narrow buildings, no corridor |
| Staffelgeschoss | Setback top floor | Doesn't count as Vollgeschoss; reduced footprint (2m gable, 1m north) |
| Vollgeschoss | Full storey (regulatory term) | Counts toward GFZ calculation |
| Schottwand | Goldbeck precast concrete wall | 62.5cm grid module |
| Wohnküche | Combined living room + kitchen | No separate kitchen room generated |
| Flur / Diele | Apartment hallway/entry | Part of the service strip |
| TGA-Schacht | Building services shaft | MEP vertical distribution |
| Flurstück | Cadastral parcel | German land registry unit |
| Gemarkung | Cadastral district | Administrative subdivision |
| Bebauungsplan | Zoning/development plan | Contains GRZ, GFZ, building lines |

## Technical Acronyms
| Term | Meaning | Context |
|------|---------|---------|
| GRZ | Grundflächenzahl | Ground coverage ratio (0.0–1.0) |
| GFZ | Geschossflächenzahl | Floor area ratio |
| IFC | Industry Foundation Classes | BIM exchange format, using IFC 2x3 |
| BIM | Building Information Modeling | 3D model with metadata |
| TGA | Technische Gebäudeausrüstung | Building services / MEP |
| WMS | Web Map Service | OGC standard for map tiles |
| WFS | Web Feature Service | OGC standard for vector features |
| ALKIS | Amtl. Liegenschaftskataster | Official German cadastral system |
| INSPIRE | EU spatial data directive | Standardizes geoportal services |
| GHA | Grasshopper Assembly | Rhino plugin format (.gha) |

## Project-Specific Terms
| Term | Meaning |
|------|---------|
| Service strip | Hallway → TGA shaft → bathroom sequence on corridor side of apartment |
| Distribution arm | 1.10m full-width hallway extension for 3+ room apartments |
| Raster / Bay width | Structural grid module: 3.125, 3.75, 4.375, 5.00, 5.625, 6.25m |
| 7-phase pipeline | Generator phases: grid snap → access type → structural grid → staircases → apartments → rooms → walls/doors/windows |
| Fitness flatline | Optimizer stuck with no improvement across generations |
| Synthetic parcel | Auto-generated 30×50m placeholder when no real cadastral data found |

## Coordinate Mapping
| Context | Convention |
|---------|------------|
| Generator | x = along length (long facade), y = along depth (short side) |
| BuildingFloorPlans | building_width_m = length_m, building_depth_m = depth_m |
| Three.js | (x, y_up, -y_plan) — Y is vertical, Z is flipped plan-Y |
| IFC | Walls at wall.start, local X along wall direction, Z extrusion |
| Wall rotation | Use atan2(dy,dx) angle directly in Three.js Y-rotation (NOT negated) |
