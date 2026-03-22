# GoldbeckSync — Grasshopper Live-Sync Plugin

## Architecture

```
┌──────────────────────┐    WebSocket     ┌──────────────────────────┐
│  Python Backend      │◄──────────────►  │  Grasshopper Plugin      │
│  (Optimizer)         │  ws://...:8000   │  (GoldbeckSync.gha)      │
│                      │   /ws/sync       │                          │
│  ┌────────────────┐  │                  │  ┌────────────────────┐  │
│  │ FloorPlan      │  │  floor_plans     │  │ GoldbeckSync       │  │
│  │ Optimizer      │──┼──────────────►   │  │ Component          │  │
│  └────────────────┘  │                  │  │  ├─ Walls (BRep)   │  │
│                      │  progress        │  │  ├─ Slabs (BRep)   │  │
│  ┌────────────────┐  │──────────────►   │  │  ├─ Windows        │  │
│  │ WebSocket      │  │                  │  │  ├─ Doors          │  │
│  │ SyncManager    │  │  geometry_edit   │  │  ├─ Bathrooms      │  │
│  └────────────────┘  │◄──────────────   │  │  ├─ Room outlines  │  │
│                      │  param_override  │  │  ├─ Grid lines     │  │
│                      │◄──────────────   │  │  └─ Labels         │  │
└──────────────────────┘                  │  └────────────────────┘  │
                                          │                          │
                                          │  ┌────────────────────┐  │
                                          │  │ GoldbeckEdit       │  │
                                          │  │ Component          │  │
                                          │  │  (sends edits back)│  │
                                          │  └────────────────────┘  │
                                          └──────────────────────────┘
```

## Prerequisites

- **Rhino 8** (Windows) with Grasshopper
- **Visual Studio 2022** with .NET desktop development workload
- **.NET Framework 4.8** targeting pack
- **Python backend** running on localhost:8000

## Build

1. Open `GoldbeckSync.sln` in Visual Studio 2022
2. Restore NuGet packages (automatic on first build)
3. Build in Release mode: `Build → Build Solution` (Ctrl+Shift+B)
4. Output: `GoldbeckSync/bin/Release/net48/GoldbeckSync.gha`

Or from command line:
```powershell
cd rhino-plugin
dotnet build GoldbeckSync/GoldbeckSync.csproj -c Release
```

## Install

1. Copy `GoldbeckSync.gha` to your Grasshopper components folder:
   ```
   %APPDATA%\Grasshopper\Libraries\
   ```
2. Copy `WebSocketSharp.dll` and `Newtonsoft.Json.dll` to the same folder
3. **Unblock the files**: Right-click each `.gha`/`.dll` → Properties → check "Unblock"
4. Restart Rhino + Grasshopper

## Usage

### GoldbeckSync Component (receiver)
1. Drop the **Goldbeck Live Sync** component onto the canvas (Tab: Goldbeck → Sync)
2. Set **ServerUrl** to `ws://localhost:8000/ws/sync` (default)
3. Set **Connect** to `True` (toggle or boolean)
4. Start an optimization run in the web app
5. Geometry appears live in Rhino as the optimizer runs

### GoldbeckEdit Component (sender)
1. Drop the **Goldbeck Edit** component onto the canvas
2. Connect a **RoomId** (from optimizer data) and a **NewBounds** rectangle
3. Or set a **ParamName** + **ParamValue** to override optimizer settings
4. Set **Send** to `True` to push the edit back to the optimizer

### Outputs from GoldbeckSync

| Output | Type | Description |
|--------|------|-------------|
| Walls | BRep list | Walls with boolean-subtracted door/window openings |
| Slabs | BRep list | Floor slabs (24cm hollow-core) |
| Windows | BRep list | Glass pane surfaces |
| Doors | BRep list | Door panel surfaces |
| Bathrooms | BRep list | Prefab bathroom pod volumes |
| Balconies | BRep list | Balcony slab volumes |
| RoomOutlines | Curve list | 2D room boundary polylines |
| ApartmentOutlines | Curve list | 2D apartment boundary polylines |
| GridLines | Curve list | Structural grid lines |
| FurnitureZones | BRep list | Furniture placement indicator volumes |
| Labels | TextDot list | Room and apartment labels with areas |
| Status | Text | Connection/optimization status |

## WebSocket Protocol

All messages are JSON with `{ "type": "...", "payload": {...} }`.

### Server → Grasshopper
- `floor_plans` — complete BuildingFloorPlans data (walls, rooms, doors, windows, etc.)
- `progress` — optimization progress (generation, fitness, percentage)
- `optimization_complete` — all variants ready
- `variant_selected` — user picked a specific variant
- `full_state` — sent on connect (current best result)

### Grasshopper → Server
- `parameter_override` — change an optimizer parameter
- `geometry_edit` — manual room boundary edit
- `request_variant` — request a specific variant by index
- `request_full_state` — re-request current state
- `ping` — keep-alive (server responds with `pong`)
