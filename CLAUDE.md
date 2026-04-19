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
**Date:** 2026-04-19
**Request:** Phase 4 — start with 4.1 Furniture feasibility overlay, then continue through 4.2 PDF export, 4.3 cost estimation.
**Progress:** Three focused additions shipped as the Phase 4.1–4.3 batch:
  1. **4.1 — Furniture feasibility overlay:** New `frontend/src/lib/furniture-layouts.ts` pure module with a DIN 18011-compliant dimension catalog (bed_double 1.80×2.00, wardrobe 2.00×0.60, sofa 2.10×0.90, kitchen_counter 3.00×0.60, wc 0.40×0.60, shower 0.90×0.90, bathtub 1.70×0.75, …) and four room-type placers (bedroom, living, kitchen, bathroom). Each placer is an axis-aligned rectangle packer that respects door-swing zones (`DOOR_CLEARANCE_M=0.80`), window sill clearances (`WINDOW_CLEARANCE_M=0.15`), wall gaps (5cm), and inter-piece gaps (10cm). Public `placeFurnitureForPlan(plan)` returns `Map<roomId, RoomFurnitureResult>`. Viewer integrates via new `furniture` layer toggle ("Möblierung (DIN)"), `placeFurnitureForPlan` computed via `useMemo`, rendered by `drawFurnitureLayer()` + `drawFurniturePiece()` with kind-specific embellishments (pillow lines on beds, back cushion on sofas, X pattern on shower, 4 hob circles on kitchen counter, labels when pieces are large enough at current zoom). `validatePlan()` emits a `not_furnishable` warning per living/bedroom/kitchen/bathroom room where `!f.fitted`, so architects see a visible reason when standard furniture doesn't fit.
  2. **4.2 — DIN A3 PDF export:** New `frontend/src/lib/floorplan-pdf.ts` using jsPDF 4.2.1. Auto-picks scale from {1:50, 1:100, 1:200, 1:500} based on plan size vs. available paper area. `rasterize()` renders to an offscreen canvas at 200 DPI (`PX_PER_MM = 200/25.4`) via a caller-provided `drawPlan` callback so the PDF reuses the exact same screen-drawing helpers (no duplicate linework). `drawTitleBlock()` renders a 90×50mm 2-column title block at right-bottom with Goldbeck-branded dark header and cells for Projekt / Gebäude / Geschoss / Maßstab / Datum / Zeichnung Nr. / Bearbeitet / Format. Viewer toolbar now has a dark "PDF A3" button alongside the PNG export. The `handleExportPdf` callback passes an inline `drawPlan` that reconstructs `(tx, ty, ts)` from the raster's `pxPerM` and replays the screen draw order (rooms → walls → openings → furniture → labels → dimensions → north arrow → scale bar) honoring the current `layers` toggles.
  3. **4.3 — Cost estimation panel:** New `frontend/src/lib/cost-estimator.ts` pure module implementing DIN 276 Kostengliederung adjusted for Goldbeck precast: KG 300 @ 1.750 €/m² BGF, KG 400 @ 520 €/m² BGF, KG 500 @ 3 % of KG 300+400, KG 700 @ 18 % of hard costs, 5 % contingency. `computeAreas()` derives BGF (per-floor grid area), NGF (room areas excl. shaft/balcony), facade, roof, BRI. `estimateCost()` also emits market-aware revenue — rent + sale benchmarks for 9 German markets (berlin 6.200 €/m², munich 10.500 €/m², rural 3.200 €/m², default 5.500 €/m²) with vacancy adjusted per market (3 % munich/frankfurt, 8 % rural/leipzig, 5 % else). New `CostPanel` React component (`components/floorplan/cost-panel.tsx`) exposes building selector, market selector, regional factor preset (0.95 / 1.0 / 1.08 / 1.15), and optional land cost input. Wired into results page as a new "Baukosten" tab next to Shadow Analysis and Financial. Shows four summary cards, a full KG 100–700 table, revenue + key ratios (cost/value ratio health-coded, gross margin), and a bezugsgrößen grid (€/WE, €/m² BGF, €/m² NGF, facade/roof/BRI).
  Typecheck + lint + build all clean (same pre-existing 5 errors / 11 warnings across unrelated files, zero new issues introduced).

## Previous Request
**Status:** DONE
**Date:** 2026-04-19
**Request:** Phase 3 completion — finish all remaining Phase 3 items (3.6b fix, 3.6c add, 3.6d extend, 3.6e extend, 3.7b extend, 3.7c) before Phase 4.
**Progress:** Six focused changes shipped as the Phase 3 completion batch:
  1. **3.6b fix — openings follow apt-boundary drag:** `applyWallDragOnPlan()` now translates every door/window whose `wall_id` is in the dragged `wallGroup` along with the wall, so openings on a moved apartment boundary no longer orphan.
  2. **3.6c add — click-to-place openings:** New `openingAddMode` state (`"none" | "window" | "door"`) plus "+ Fenster" / "+ Tür" sub-toolbar buttons (shown only in Opening edit mode). Pure `applyNewOpeningOnPlan()` helper classifies the nearest wall axis, enforces the exterior-wall rule for windows, validates min-edge + collision, and creates the new element with a `genUuid()` fallback-safe UUID and sensible defaults (window 1.20m × 1.50m, sill 0.90m; door 0.95m × 2.00m). Esc priority: cancel add-mode → deselect → exit opening mode.
  3. **3.6d add — Wohnküche split / kitchen merge:** New topology footer in `RoomTypePopover` with two buttons: "In Wohnzimmer + Küche teilen" (only if room is a rectangular living ≥ 20m²) and "Mit Küche vereinen" (only if an adjacent rectangular kitchen in the same apartment shares a full edge). Pure helpers `applyWohnkuecheSplit()` splits along the longer axis with the kitchen getting 30% of the footprint and inserts a new partition wall; `applyKitchenMerge()` unions the two polygons as their bbox, removes the kitchen + shared walls + openings on those walls, relabels the result as "Wohnküche", and recomputes `apartment_type` from the new room composition. Shared-edge detection via `findSharedEdge()` (axis + coord match with ≥1m overlap, 5cm tol).
  4. **3.6e add — DIN 5034 window-presence check:** `validatePlan()` now emits a `no_window` error per habitable room (living/bedroom/kitchen) whose inflated bbox contains no window point (0.3m tolerance so exterior-edge windows count). Reuses the aspect-ratio bbox computation.
  5. **3.7b add — LRU quota eviction:** `project-store.ts` now uses a custom `quotaAwareStorage()` wrapper. On `QuotaExceededError` (DOMException code 22 / 1014 / name match), it parses the persisted JSON, finds the oldest `editedFloorPlans` entry by `savedAt`, deletes it, retries — up to `MAX_EVICT=50` iterations. Non-quota errors and empty-cache cases throw descriptive errors.
  6. **3.7c — backend-backed persistence:** New `EditedFloorPlan` SQL model (`building_id`, `floor_index`, `original_fingerprint`, `plan_json`, timestamps) with a composite unique constraint. New `GET/PUT/DELETE /floorplan/overrides/{building_id}/{floor_index}` endpoints + `GET /floorplan/overrides` list + `DELETE /floorplan/overrides` purge, wired into `v1/router.py`. Frontend client at `lib/floorplan-overrides.ts`. Viewer hydrates from backend on mount when localStorage is empty or stale (fingerprint check), debounces a 400ms PUT on every commit, and fires DELETE on Reset / revert-to-original. All backend calls fire-and-forget — localStorage remains the primary cache so network failures never block editing. Per-user scoping deferred until auth lands.
  Typecheck clean; end-to-end SQL roundtrip verified.

## Previous Request
**Status:** DONE
**Date:** 2026-04-18
**Request:** Phase 3.7b — Edit persistence via localStorage
**Progress:** Project store wrapped in Zustand `persist` middleware (localStorage, `name: "goldbeck-project-store"`). New `editedFloorPlans: Record<string, EditedFloorPlanEntry>` slice keyed by `${buildingId}:${floorIndex}` stores the edited plan alongside a 32-bit FNV-1a fingerprint of the ORIGINAL plan (stable UUIDs-based hash). Viewer reads `buildingId` / `floorIndex` props from the panel; lazy history initializer checks the store and hydrates from the saved plan only when fingerprints match (a regenerated plan has new UUIDs → mismatch → fall back to fresh stack, stale edits cleanly ignored). A persistence effect mirrors the current history tip to the store on every commit/undo/redo; if the tip reverts to the original, the entry is cleared. Reset button eagerly clears the store entry. Amber "wiederhergestellt" pill appears in the toolbar while a restored edit is active. Typecheck + lint + build all clean.

## Previous Request
**Status:** DONE
**Date:** 2026-04-18
**Request:** Phase 3.7a — Undo / redo history
**Progress:** Bounded 20-step history stack (`{ stack: FloorPlan[]; index: number }`). `commitEdit(plan)` pushes onto history, truncating any existing redo tail. Undo/redo just move the index; an effect syncs `editedPlan` to `history.stack[history.index]` on every history change. Live drag frames still use `setEditedPlan` directly (no history pollution); only the final valid commit on mouseup calls `commitEdit`. Same for opening deletion (Delete/Backspace) and room type reassignment. Keyboard: Ctrl+Z (undo), Ctrl+Y / Ctrl+Shift+Z (redo), no-ops during an active drag. New segmented Undo/Redo button group in the toolbar (↶ / ↷ glyphs) with disabled state + step counter in the title tooltip. Reset button now clears history to `{ [floorPlan], 0 }`. New plan prop resets the stack too. Typecheck + lint + build all clean.

## Previous Request
**Status:** DONE
**Date:** 2026-04-18
**Request:** Phase 3.6e — Real-time validation overlay
**Progress:** `validatePlan()` runs on every plan change via `useMemo`. Per-room checks: DIN minimum area (error) and habitable room aspect ratio > 3:1 (warn). Per-apartment checks: missing bathroom (error), no living/kitchen (error), and declared `{N}_room` vs composition (warn). Circular count badges overlay offending rooms and apartments (red errors / amber warnings, filled with white stroke + drop shadow, offset toward the top-right corner of the scope). Collapsible bottom-right `ValidationPanel` shows either a green "Validierung OK" pill or a red/amber count pill; when opened, issues are grouped by apartment (error-first), each row clickable to flash the room on the canvas + open the inspector. New `validation` layer key toggles the overlay via the Layers dropdown. Typecheck + lint + build all clean.

## Previous Request
**Status:** DONE
**Date:** 2026-04-18
**Request:** Phase 3.6d — Room type reassignment
**Progress:** New "Rooms" edit mode added to the viewer toolbar (violet). Click any reassignable room (living/bedroom/kitchen/bathroom/hallway/storage) to open a popover offering the six DIN-valid types. Types whose minimum area exceeds the clicked room's area are disabled with a tooltip showing the required minimum. Applying a new type updates the room label, renumbers bedrooms left-to-right by centroid X inside the owning apartment, and recomputes `apartment_type = ${N}_room` where N = bedroom count + (hasLiving ? 1 : 0), capped at [1,5] to match the backend enum. Typecheck + lint + build all clean.

## Current State
**Last updated:** 2026-04-19

### Recently completed
- **Phase 4.1–4.3 batch** (2026-04-19):
  - **4.1 Furniture feasibility overlay** — New `frontend/src/lib/furniture-layouts.ts` pure module (~500 lines). DIN 18011 dimension catalog (bed_double / bed_single / nightstand / wardrobe / sofa / coffee_table / tv_unit / dining_table / kitchen_counter / kitchen_island / fridge / wc / sink / shower / bathtub / desk / chair). Four axis-aligned rectangle packer placers (`placeBedroom`, `placeLiving`, `placeKitchen`, `placeBathroom`) respecting `DOOR_CLEARANCE_M=0.80` door-swing zones, `WINDOW_CLEARANCE_M=0.15` sill offsets, `WALL_GAP_M=0.05`, `PIECE_GAP_M=0.10`. Geometry helpers: `roomBBox`, `isAxisAlignedRect`, `collectDoorZones`, `findClearRun`, `rectIntersects`, `fitsInBox`, `noCollision`. Public `placeFurnitureForPlan(plan): Map<string, RoomFurnitureResult>` dispatches by room type, treats Wohnküche (living ≥ 20 m² without separate kitchen in apt) as kitchen for placement. Viewer integration: new `furniture: false` entry in `layers` state + "Möblierung (DIN)" toggle in Layers panel; `furnitureByRoom = useMemo(() => placeFurnitureForPlan(plan), [plan])` computed once per plan change; `drawFurnitureLayer()` + `drawFurniturePiece()` draw pieces in `FURNITURE_COLORS` palette with kind-specific embellishments (pillow lines, back cushion, X pattern on shower, 4 hob circles on kitchen counter, labels when piece is large enough at current zoom). `validatePlan(plan, furnitureByRoom?)` extended to emit a `not_furnishable` warning per living/bedroom/kitchen/bathroom where `!f.fitted`, so architects see the reason ("Raum zu klein für Standard-Schlafzimmermöbel" etc.) directly in the validation panel.
  - **4.2 DIN A3 PDF export** — New `frontend/src/lib/floorplan-pdf.ts` using jsPDF 4.2.1. Constants: A3 landscape 420×297 mm, 15 mm margin, 90×50 mm title block, `EXPORT_DPI = 200` (`PX_PER_MM = 200/25.4`). `pickScale(planW, planH, availW, availH)` walks [50, 100, 200, 500], returns first where the plan + 8 mm padding fits. `rasterize(plan, scale, drawPlan)` creates an offscreen canvas sized in paper-mm × DPI, white-fills, invokes a caller-provided `drawPlan(ctx, pxW, pxH, pxPerM)` callback, returns PNG data URL + widthMm/heightMm. This callback pattern keeps the PDF linework identical to the screen without duplicating draw code. `drawTitleBlock()` draws Goldbeck-branded dark header strip + 2×4 grid: Projekt / Gebäude / Geschoss / Maßstab / Datum / Zeichnung Nr. / Bearbeitet / Format + optional notes row. Public `exportFloorPlanPdf(opts)` composes the full PDF; `downloadFloorPlanPdf(opts, filename?)` triggers browser save with auto-name `{project}_{floor}_1-{scale}.pdf`. Viewer integration: new dark "PDF A3" button next to the PNG export, `handleExportPdf` callback builds a title block from the project store and passes an inline `drawPlan` that reconstructs `(tx, ty, ts)` from `pxPerM` and replays the screen draw order (rooms → walls → openings → furniture → labels → dimensions → north arrow → scale bar) honoring the current `layers` toggles.
  - **4.3 Cost estimation panel** — New `frontend/src/lib/cost-estimator.ts` pure module implementing DIN 276 Kostengliederung adjusted for Goldbeck precast (BKI 2024 Wohnungsbau − 8–12 %): `KG300_PER_SQM_BGF = 1_750`, `KG400_PER_SQM_BGF = 520`, `KG500_RATIO_OF_300_400 = 0.03`, `KG700_RATIO_OF_HARD_COSTS = 0.18`, `CONTINGENCY_RATIO = 0.05`. `computeAreas(building)` sums per-floor BGF (grid w×d — naturally handles Staffelgeschoss's smaller grid), NGF (excl. shaft + balcony), facade (Σ perimeter × story_height), roof (top floor footprint), BRI. `estimateCost(input)` returns full breakdown with `perUnit`, `perSqmBgf`, `perSqmNgf`, revenue (market-aware rent + sale price benchmarks for 9 German markets: berlin 6.200 €/m², munich 10.500 €/m², rural 3.200 €/m², default 5.500 €/m²; vacancy 3 % munich/frankfurt, 8 % rural/leipzig, 5 % else), `costToValueRatio`, `grossMargin`, `grossMarginPct`. Helpers `formatEur` (de-DE currency, integer default) and `formatArea` (de-DE m²). New `CostPanel` component (`frontend/src/components/floorplan/cost-panel.tsx`) — building selector, market selector (10 options), regional factor preset (0.95 / 1.0 / 1.08 / 1.15), optional land cost input. Renders 4 summary cards, full KG 100–700 DIN 276 table, revenue + ratios card (cost/value color-coded healthy < 0.75 / knapp < 0.90 / kritisch ≥ 0.90), and bezugsgrößen grid (€/WE, €/m² BGF, €/m² NGF, facade/roof/BRI/Geschosse). Wired into results page as a new "Baukosten" tab between "Shadow Analysis" and "Financial".
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (heavy — furniture draw + PDF export wiring), `frontend/src/components/floorplan/cost-panel.tsx` (new), `frontend/src/app/project/results/page.tsx`, `frontend/src/lib/furniture-layouts.ts` (new), `frontend/src/lib/floorplan-pdf.ts` (new), `frontend/src/lib/cost-estimator.ts` (new), `CLAUDE.md`.
  - Dependencies: `jspdf@4.2.1` (added for PDF export). No backend changes required.
  - Typecheck + `next build` clean; lint back to pre-existing 5 errors / 11 warnings (zero new issues in any of the new files).
- **Phase 3 completion batch** (2026-04-19):
  - **3.6b — openings follow apt-boundary drag.** `applyWallDragOnPlan()` in `floor-plan-viewer.tsx` now also maps `basePlan.doors` and `basePlan.windows`, translating the moved axis coord for any opening whose `wall_id` is in the wallGroup Set. Return plan includes `doors` + `windows` alongside the updated walls + rooms.
  - **3.6c — add new door/window.** New `openingAddMode` state. Opening-edit toolbar grows two sub-buttons "+ Fenster" / "+ Tür" (sky-blue, mutually exclusive). While active, any click in empty space finds the nearest wall axis-projects through `applyNewOpeningOnPlan(basePlan, kind, planX, planY, snap)` which enforces (1) window must be on exterior wall, (2) opening must fit fully within wall length, (3) no collision with existing openings on the same wall (MIN_OPENING_GAP_M padded). Valid placement commits via `commitEdit` + auto-selects the new opening. Constants: `DEFAULT_WINDOW_WIDTH_M=1.20`, `DEFAULT_WINDOW_HEIGHT_M=1.50`, `DEFAULT_WINDOW_SILL_M=0.90`, `DEFAULT_DOOR_WIDTH_M=0.95`, `DEFAULT_DOOR_HEIGHT_M=2.00`. `genUuid()` uses `crypto.randomUUID()` with Math.random fallback.
  - **3.6d extension — Wohnküche split / kitchen merge.** `RoomTypePopover` gained four new props (`canSplit`, `canMerge`, `onSplit`, `onMerge`) and a "Topologie" footer section rendering conditionally. `applyWohnkuecheSplit(basePlan, roomId)` validates room is living + rectangular + ≥ `MIN_WOHNKUECHE_SPLIT_AREA_SQM=20.0` m², splits along the longer axis with the kitchen getting `WOHNKUECHE_SPLIT_KITCHEN_FRAC=30%`, inserts a new non-bearing partition wall (`thickness_m=0.115`), relabels the shrunken half as "Wohnen", names the new kitchen room, and recomputes `apartment_type`. `applyKitchenMerge(basePlan, livingRoomId)` uses `findSharedEdge(polyA, polyB)` (axis + coord match within `SHARED_EDGE_TOL=0.05m`, ≥1m perpendicular overlap) to locate the kitchen's adjacent edge, unions the two polygons as their bbox, removes the kitchen + walls on the shared edge + openings on those walls, relabels the survivor as "Wohnküche", recomputes `apartment_type`. Popover compute-site gates `canSplit` / `canMerge` on live room state.
  - **3.6e extension — DIN 5034 window check.** Added to `validatePlan()`: for every habitable room (living/bedroom/kitchen) without `no_window` already emitted, inflate the room bbox by 0.3m and check `plan.windows.some(w => w.position in bbox)`. Missing → error "{label}: kein Fenster (DIN 5034 Tageslicht)". Refactored to share `minX/maxX/minY/maxY` with aspect-ratio check.
  - **3.7b extension — LRU quota eviction.** `quotaAwareStorage()` in `stores/project-store.ts` returns a `Storage` shim that delegates to `localStorage` but catches `QuotaExceededError` (code 22 / 1014 / name `QuotaExceededError` / `NS_ERROR_DOM_QUOTA_REACHED`) in `setItem`, parses the persisted payload, removes the `editedFloorPlans` entry with the oldest `savedAt`, and retries. Loops up to 50 evictions. `console.info` on each eviction, descriptive throw when edits exhausted but quota still exceeded. SSR-safe noop branch when `window === undefined`. Wired via `createJSONStorage(() => quotaAwareStorage())`.
  - **3.7c — backend-backed override persistence.** New SQL model `EditedFloorPlan` in `backend/app/database/models.py` (`id`, `building_id`, `floor_index`, `original_fingerprint`, `plan_json`, `saved_at`, `created_at`) with composite `UniqueConstraint("building_id","floor_index")` + `Index`. Auto-migrated via `init_db()` / `Base.metadata.create_all`. New `backend/app/api/v1/floorplan_overrides.py` exposes five endpoints: `GET ""` (summary list), `GET /{building_id}/{floor_index}` (full body, 404 if missing), `PUT /{building_id}/{floor_index}` (upsert — `OverrideIn` with `original_fingerprint` + `plan`), `DELETE /{building_id}/{floor_index}` (idempotent, returns `{deleted: bool}`), `DELETE ""` (purge all). Wired into router with prefix `/floorplan/overrides`. Frontend client `frontend/src/lib/floorplan-overrides.ts` exposes `listOverrides`, `fetchOverride` (returns `null` on 404), `putOverride`, `deleteOverride`. Viewer integration: (1) mount-time hydration effect fetches when localStorage is missing/stale — gated on fingerprint match + no concurrent local edit; (2) persistence effect now ALSO fires a debounced 400ms PUT per commit (`backendSyncTimerRef`) and an immediate DELETE on revert-to-original; (3) Reset button fires DELETE. All backend calls wrapped in `.catch(console.debug)` — localStorage remains the primary cache so network failures never block editing. End-to-end SQL roundtrip verified via a throwaway test (`building_id='bld-1', floor_index=0` insert + select). Dependencies: installed `sqlalchemy>=2.0` + `aiosqlite>=0.20.0` into `backend/venv` (were in `requirements.txt` but not installed).
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx`, `frontend/src/stores/project-store.ts`, `frontend/src/lib/floorplan-overrides.ts` (new), `backend/app/database/models.py`, `backend/app/database/__init__.py`, `backend/app/api/v1/floorplan_overrides.py` (new), `backend/app/api/v1/router.py`, `CLAUDE.md`.
  - Typecheck clean; backend import + SQL roundtrip verified.
- **Phase 3.7b: Edit persistence via localStorage** (2026-04-18):
  - `project-store.ts` wrapped in `persist(..., { name: "goldbeck-project-store", storage: createJSONStorage(() => localStorage), version: 1, partialize })`. Partialize excludes the heavy `optimizationResult` and transient UI (`activeTab`, `currentStep`, `_undoStack`, `_redoStack`, `canUndo`, `canRedo`). New `editedFloorPlans: Record<string, EditedFloorPlanEntry>` slice with `{ originalFingerprint, plan, savedAt }`; helpers `setEditedFloorPlan`, `clearEditedFloorPlan`, `clearAllEditedFloorPlans`. Key format via `editedPlanKey(buildingId, floorIndex)` = `"${buildingId}:${floorIndex}"`.
  - `fingerprintPlan(plan)` helper in the viewer: FNV-1a 32-bit hash over `floor_index`, building dims, element counts + sorted UUIDs of rooms/walls/doors/windows. Fingerprint is stable through a user edit session (UUIDs don't change on polygon edits) but changes when the optimizer produces a fresh plan (new UUIDs) — stored edits then correctly invalidated on mismatch.
  - Viewer accepts optional `buildingId` + `floorIndex` props (passed from `floor-plan-panel.tsx` as `selectedBuildingId ?? undefined` + `selectedFloorIndex`). `persistKey` is `useMemo`d; lazy `useState` initializer for `history` reads `useProjectStore.getState().editedFloorPlans[persistKey]` once on mount and hydrates `{ stack: [entry.plan], index: 0 }` only when `entry.originalFingerprint === fingerprintPlan(floorPlan)`. Otherwise falls back to clean `{ stack: [floorPlan], index: 0 }`.
  - Prop-change path (user navigates floor/building) re-checks the store against the new plan's fingerprint, hydrates if match, falls back otherwise.
  - Persistence effect mirrors `history.stack[history.index]` to the store on every history change. When the tip reverts to the original plan (undo-all), the entry is cleared so the next mount doesn't show a stale "wiederhergestellt" pill.
  - Reset button also calls `clearEditedFloorPlan(persistKey)` directly (not just via the effect) so the pill disappears immediately.
  - Toolbar indicator: small amber pill ("wiederhergestellt") between the Undo/Redo group and the Edit button; shows only while `restoredFromStore && editedPlan !== floorPlan`.
  - Guarded: everything no-ops when `buildingId` or `floorIndex` is not passed, so the viewer still works unpersisted on any future callsite.
  - Files changed: `frontend/src/stores/project-store.ts` (+~60 lines), `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~75 lines), `frontend/src/components/floorplan/floor-plan-panel.tsx` (+2 props).
  - Typecheck clean; `next build` green; lint unchanged (no new issues, same pre-existing 5 errors / 11 warnings across unrelated files).
  - Still pending: 3.7c backend-backed persistence (SQL `FloorPlanRun` table, save/load endpoints, cross-device sync).
- **Phase 3.7a: Undo / redo history** (2026-04-18):
  - Bounded stack of `FloorPlan` snapshots (`MAX_HISTORY = 20`). State shape is a single `{ stack, index }` object so `setHistory` updates both atomically; going past MAX_HISTORY evicts from the front.
  - `commitEdit(plan)` is the single entry point for committing discrete edits. It slices off any redo tail (`stack.slice(0, index + 1)`), appends the new plan, and advances the index. Called from: wall-drag mouseup (valid & moved), opening-drag mouseup (valid & changed), opening Delete/Backspace, and RoomTypePopover `onApply`.
  - `undo()` / `redo()` just move the index (clamped to `[0, stack.length - 1]`). An effect `useEffect(() => setEditedPlan(history.stack[history.index]), [history])` syncs `editedPlan` to whatever slot the index points at. Live drag frames still call `setEditedPlan` directly without touching history — same design as before — and the effect no-ops when `history` doesn't change.
  - `editedPlanRef` keeps the latest editedPlan accessible to `handleMouseUp` / the keydown handler without adding it to the useCallback deps (would cause recreation on every drag frame).
  - Keyboard: `Ctrl+Z` (or `Cmd+Z` on mac) → undo, `Ctrl+Shift+Z` / `Ctrl+Y` → redo. `preventDefault()` called so the browser's built-in undo doesn't also fire. Suppressed while a drag is active (consistent with the existing Esc-first rule).
  - Toolbar: new segmented Undo/Redo button group (↶ / ↷ glyphs) placed between the Layers dropdown and the Edit mode button. Disabled state when at stack endpoints or during a drag. Tooltips show the remaining step count ("N Schritte verfügbar").
  - Reset button reworked to reset history (`setHistory({ stack: [floorPlan], index: 0 })`) rather than just `setEditedPlan(floorPlan)`, so the user can't undo-back-into already-discarded edits.
  - Plan-prop change path also resets history via the same pattern — the new server plan becomes the sole history entry.
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~90 lines)
  - Typecheck clean; `next build` green; lint back to pre-existing 4 issues (0 introduced).
  - Still pending: 3.7b persistence (user_overrides on FloorPlan + optimizer-rerun preservation).
- **Phase 3.6e: Real-time validation overlay** (2026-04-18):
  - Module-scope `validatePlan(plan)` returns `{ issues, byRoom, byApartment, byApartmentAll, errorCount, warnCount }`. Recomputed via `useMemo([plan])` on every edit — O(rooms + apartments), trivially cheap for typical floors.
  - Per-room checks: `area_sqm < MIN_ROOM_AREA_SQM[type]` (error, message includes both actual and required m²), plus habitable-room (living/bedroom/kitchen) bounding-box aspect ratio > 3:1 (warn, "schwer möblierbar").
  - Per-apartment checks: missing bathroom (error, checks both `apt.bathroom.area_sqm > 0` and any `bathroom`-type room), missing both living and kitchen (error), and declared `apartment_type` ("3_room" etc.) vs live composition `bedrooms + (hasLiving ? 1 : 0)` — mismatch emits a warn ("3-Zimmer deklariert, tatsächlich 2-Zimmer").
  - Canvas overlay: `drawValidationOverlay()` draws small filled circular badges (r=10px) — red for error-containing scope, amber for warn-only. Count centered in white. Positioned at 65% from room centroid toward top-right bounding-box corner so the badge doesn't clobber the room label. Apartment-level issues get a badge at the combined rooms' top-right. Drop shadow keeps it legible against any room fill.
  - `ValidationPanel` React component (bottom-right, z-20): collapsed pill is green ("Validierung OK"), red ("N Fehler") or amber ("N Hinweise"); expanded shows a scrollable issue list (max 60% viewport height) grouped by apartment, error-first sort, each row clicks to `focusRoom` (flash the offending room with a dashed amber outline for 1.8s + open the Inspector on it) or `focusApartment` (selects it via `onApartmentSelect`). Apartment group header is also clickable to jump to the apartment.
  - New `validation` layer in the Layers dropdown — on by default in Architect mode, off in Presentation mode (via `applyViewMode`).
  - Focus flash uses a `focusedRoomId` state + timer ref; draw effect renders an amber dashed outline while active. Timer cleared on remount or subsequent focus.
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~380 lines incl. the panel, overlay helper, and validator)
  - Typecheck clean; `next build` green; lint back to pre-existing 4 issues (0 introduced).
  - Still pending: 3.7 persistence + undo/redo.
- **Phase 3.6d: Room type reassignment** (2026-04-18):
  - New "Rooms" edit-mode toolbar button (violet when active) — mutually exclusive with "Edit" (wall) and "Openings" modes. Enter-the-mode dims every reassignable room with a faint dashed violet outline; hover brightens the outline; the room whose popover is open gets a solid violet outline + light fill.
  - Hit-test: `findRoomAtClick()` picks the innermost containing room (smallest-area tiebreaker) via `isPointInPolygon` — screen-space point projected back through the current zoom/pan transform.
  - Reassignable set: `REASSIGNABLE_ROOM_TYPES = [living, bedroom, kitchen, bathroom, hallway, storage]`. Structural / shared types (corridor, staircase, elevator, shaft, balcony) intentionally excluded.
  - Popover: `RoomTypePopover` component floats near the click anchor (clamped so it doesn't overflow the viewport). Header shows current label + area. Six option buttons in a 2-column grid use German labels (Wohnen / Schlafen / Küche / Bad / Flur / Abstellraum) and show the DIN minimum below each label. Current type gets a violet filled button with ring + "Bereits zugewiesen" tooltip. Options where `MIN_ROOM_AREA_SQM[type] > room.area_sqm` are disabled with a tooltip showing the required minimum (same DIN table as 3.6a: living 14, bedroom 8, kitchen 4, bathroom 2.5, hallway 1.5, storage 0.5 m²). × close button + Esc close.
  - Pure application helper: `applyRoomTypeChangeOnPlan(basePlan, roomId, newType)` returns the next plan with (1) `room.room_type = newType` and a default label (`Wohnküche` / `Bedroom` / `Kitchen` / …) and (2) per-apartment bedroom re-numbering — bedrooms sorted left-to-right by centroid X so labels become `Bedroom 1`, `Bedroom 2`, … (single bedroom stays just "Bedroom"). The flat `plan.rooms` list is mirror-relabeled via a Map so the viewer's label rendering stays in sync.
  - Apartment type recomputation: `bedroomCount + (hasLiving ? 1 : 0)` → `${zimmerCount}_room`, clamped to `[1,5]` to match the backend `apartment_type` enum. Fires automatically on every reassignment.
  - Esc priority in room mode: close popover → exit room mode.
  - Files changed: `frontend/src/components/floorplan/floor-plan-viewer.tsx` (+~310 lines including the popover component and overlay draw helper)
  - Typecheck clean; `next build` green; lint back to pre-existing 4 issues (0 introduced).
  - Still pending: 3.6e real-time per-apartment validation overlay, 3.7 persistence + undo/redo.
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
- **Phase 4.1–4.3 — COMPLETE.** Furniture feasibility overlay, DIN A3 PDF export, and DIN 276 cost estimation panel all shipped. Remaining Phase 4 items (deferred — not yet scoped): 4.4 thermal envelope analysis, 4.5 multi-building coordination, 4.6 BIM (IFC) enrichment with furniture + cost metadata.
- **Phase 3 — COMPLETE.** Every scoped sub-item (3.0–3.5 viewer upgrade, 3.6a–3.6e interactive editing, 3.7a undo/redo, 3.7b localStorage persistence with LRU eviction, 3.7c backend-backed persistence) has shipped.
- **Cost estimator — benchmarks are national averages.** KG 300/400 rates are BKI 2024 Wohnungsbau mid-range adjusted −8–12 % for Goldbeck precast. Rent + sale price benchmarks are per-market (9 German cities + default). For a real pitch to a client, the caller should override with site-specific BKI data or a fresh comparable analysis — our output is an intentional grobkostenrahmen, never a Leistungsphase-3 Kostenberechnung.
- **Furniture placer — rectangular rooms only.** `placeFurnitureForPlan` evaluates axis-aligned bbox feasibility; L-shaped or angled rooms get placements that may clip outside the polygon. Goldbeck generator only emits rectangular rooms today, so this is a non-issue. Revisit if polygon editing (future Phase 3.x extension) introduces non-rect rooms.
- **PDF export — no multi-floor / multi-building batch.** One plan per A3 sheet. To export all floors of a building or all buildings of a project in one batch, iterate in the caller and use `exportFloorPlanPdf` (returns the jsPDF instance) to combine via `pdf.addPage()`. Nice-to-have for project deliverables; skip until needed.
- **Persistence — fingerprint is UUID-based** — When the optimizer re-runs (different seed / different GA params) the new plan has new UUIDs → fingerprint mismatch → stored edits discarded, user sees fresh output. If we ever make UUIDs stable across regenerations (e.g., room labels as IDs) this will need a structural fingerprint alternative to avoid clobbering intentional regeneration.
- **Persistence — no user scoping yet** — 3.7c's `EditedFloorPlan` table is single-tenant. Multi-user setups would clobber each other. Add `user_id` + unique(`user_id`, `building_id`, `floor_index`) when auth lands, and filter every endpoint read/write.
- **Persistence — backend sync is fire-and-forget** — PUT failures are only logged to `console.debug`. If the backend stays down during an edit session, localStorage still holds the edits but other devices won't see them until a successful PUT. Acceptable for single-user dev; revisit when auth + server sync reliability matter.
- **Room reassignment — apartment_type cap** — backend enum is "1_room" … "5_room". A reassignment that pushes N above 5 (e.g. turning every room into a bedroom in a large apartment) is silently clamped to 5. If the user then regenerates or exports IFC, the exported apartment carries the clamped label. Rare in practice (backend-generated apartments are 1–4 rooms) but worth noting.
- **Validation — no fire-egress check (DEFERRED).** The IMPLEMENTATION_PLAN mentioned "Fire egress distance exceeded for apt B03" as an example. Skipped because true egress calculation needs a graph from every apartment entrance to the nearest staircase through corridor polygons — significantly more work than a per-room check and rarely violated by the generator. Track separately if a compliance pass becomes required.
- **Wall-drag — T-junction edge case (DEFERRED).** Partition-drag only handles axis-aligned walls shared by two neighboring rooms. T-junctions (a wall ending mid-room) will find no match on one side; the single affected room translates its vertices fine but the wall may no longer meet the perpendicular wall exactly. Current Goldbeck generator output never produces this topology (all partitions span corridor-to-corridor or gable-to-gable, all apt boundaries are full-building bearing_cross), so it's a non-issue today. Revisit only if a future generator emits T-junctions or users gain freeform wall drawing.
- **Opening edit — door resize (DEFERRED).** Doors have fixed widths; only windows get resize handles. This matches BauO NRW practice (door widths are prescriptive: 0.875m standard, 0.95m barrier-free, 1.00m double). Expose resize handles only if the backend starts emitting non-standard door widths.
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
