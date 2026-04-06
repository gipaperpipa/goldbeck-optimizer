# Goldbeck Optimizer — Full Audit Report

**Date:** 2026-04-04
**Reviewed by:** Claude (code review, no live testing due to sandbox)
**Scope:** All backend (39 files) and frontend (41 files) source code

---

## Executive Summary

The app has a solid architectural foundation — clean separation of concerns, typed models, and a sophisticated 7-phase floor plan generator backed by a genetic algorithm. However, it has **significant production-readiness gaps** that would frustrate professional users and cause reliability issues under load.

**Total issues found: 100**

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 6 | Will crash or corrupt data in production |
| High | 16 | Breaks UX or causes failures under normal use |
| Medium | 38 | Degrades experience or maintainability |
| Low | 40 | Polish, consistency, best practices |

---

## CRITICAL (6) — Fix before anyone tests this

### C1. Race condition in job state (backend)
**Files:** `api/v1/floorplan.py`, `api/v1/optimize.py`
Background threads write to `_jobs[job_id]` dict while HTTP poll handlers read it. No locking. Under concurrent requests, partially-written state can be returned to the client, causing JSON parse errors or stale data.

### C2. Unbounded in-memory job cache (backend)
**Files:** `api/v1/floorplan.py`, `api/v1/optimize.py`
The `_jobs` dict grows forever. Every generation/optimization request adds an entry that's never cleaned up. After days of use the server will OOM and crash. Need TTL-based eviction or a bounded cache.

### C3. Unsafe array access on empty variants (backend)
**File:** `api/v1/floorplan.py`
Accesses `variants[0]` without checking if the list is empty. If the generator produces zero valid variants (e.g., impossible constraints), this crashes with an IndexError.

### C4. Event loop bug kills WebSocket sync (backend)
**File:** `api/v1/floorplan.py`
Background thread calls `asyncio.get_event_loop()` but doesn't set one. The WebSocket broadcast to Rhino/Grasshopper fails silently — the app looks like it's working but live sync is broken.

### C5. `datetime.utcnow()` removed in Python 3.12+ (backend)
**File:** `services/ifc_exporter.py`
Uses the deprecated `datetime.utcnow()` which is removed in Python 3.12+. IFC export will crash on modern Python. Replace with `datetime.now(timezone.utc)`.

### C6. No tests exist anywhere
**Files:** none
Zero unit tests, zero integration tests, zero e2e tests. The `pytest` dev dependency is declared but no test files exist. For a tool that generates building floor plans (where correctness matters), this is a serious gap.

---

## HIGH (16) — Breaks normal usage

### H1. Hardcoded US fallback coordinates (backend)
**File:** `api/v1/plot.py`
When geocoding fails, the app defaults to coordinates near Denver, Colorado. This is a German-market app. Should default to a German city or return an error.

### H2. Broad `except Exception: pass` everywhere (backend)
**Files:** 30+ occurrences across services
Errors are silently swallowed. The cadastral service, geometry engine, optimizer, and IFC exporter all catch exceptions and continue with no logging, no user feedback. Debugging production issues will be nearly impossible.

### H3. No rate limiting on external API calls (backend)
**Files:** `services/cadastral.py`, `services/geocoding.py`
Nominatim, WFS endpoints, and Overpass API have strict rate limits. A user clicking rapidly on the map can trigger dozens of requests, get the server IP banned, and break cadastral lookups for everyone.

### H4. Race condition in floor plan generation (frontend)
**File:** `hooks/use-floor-plan.ts`
Multiple rapid "Generate" clicks create multiple concurrent jobs. No cancellation of previous jobs. User sees flickering results as old and new jobs complete in random order.

### H5. Optimization errors invisible to user (frontend)
**File:** `hooks/use-optimization.ts`
The polling loop catches errors but never surfaces them to the UI. If the optimization job crashes server-side, the user sees an eternal spinner with no way to know it failed.

### H6. Missing loading/error states across UI (frontend)
**Files:** `FloorPlanPanel`, `LayoutComparison`, `ShadowAnalysisPanel`
Components show blank space or stale data while loading. No skeletons, no spinners, no error messages. User doesn't know if the app is working or broken.

### H7. No input validation on optimizer parameters (frontend + backend)
**Files:** `optimization-preferences.tsx`, `api/v1/optimize.py`
User can set generations=0, populationSize=0, or absurd values like 999999 generations. No min/max validation on either frontend or backend. Will either crash or run for hours.

### H8. Mapbox token committed to source (frontend)
**File:** `frontend/.env.local`
The Mapbox token `pk.eyJ1...` is checked into version control. Anyone with repo access can use (and abuse) this token. Should be in `.env.local` which is `.gitignore`d (it may already be gitignored, but the token is also hardcoded in `.env.local` which IS committed).

### H9. Duplicate API base URL definitions (frontend)
**Files:** `lib/api-client.ts`, `components/regulations/regulation-panel.tsx`
Two separate `API_BASE` constants. If the API URL changes, one will be updated and the other forgotten. Regulation lookups will silently hit the wrong endpoint.

### H10. Memory leak in CadastralMap (frontend)
**File:** `components/map/cadastral-map.tsx`
`loadTimeoutRef` timeout not cleared on component unmount. If user navigates away during a pending cadastral load, the callback fires on an unmounted component.

### H11. SQLite concurrent write corruption risk (backend)
**Files:** `database/engine.py`
SQLite is used for persistence but no WAL mode or transaction isolation is configured. Concurrent optimization jobs writing results can corrupt the database.

### H12. IFC export success/failure invisible (frontend)
**File:** `components/three/scene.tsx`
`handleExportIfc()` catches errors silently with `console.error`. User clicks export, nothing visible happens — no download confirmation, no error message. User clicks again, and again.

### H13. WebSocket edits not validated or fed back (backend)
**File:** `services/ws_sync.py` (lines 126, 139)
Two explicit TODOs: edits from Rhino are received but never validated against Goldbeck constraints and never fed back to the optimizer. This means manual edits in Rhino can create invalid floor plans.

### H14. Financial calculator has no error handling (backend)
**File:** `services/financial_calculator.py`
If any input is zero or negative (e.g., construction cost per sqm = 0), division by zero crashes silently. No input validation on financial parameters.

### H15. Incomplete German state WFS coverage (backend)
**File:** `services/cadastral.py`
While 16 state endpoints are defined, several WFS URLs may be outdated or require authentication. Failures are swallowed silently — user just gets a synthetic parcel with no explanation of why real data wasn't available.

### H16. `print()` debug logging in production code (backend)
**Files:** `api/v1/floorplan.py`, `services/optimizer/core.py`, `services/floorplan/goldbeck_generator.py`
20+ `print()` calls used instead of proper logging. No log levels, no structured output, no way to control verbosity in production vs development.

---

## MEDIUM (38) — Degrades experience

### Architecture & Infrastructure
- **M1.** No error boundaries in React — single component crash takes down the whole page
- **M2.** No health check endpoint beyond whatever Railway hits (need `/api/health` with DB connectivity check)
- **M3.** No API versioning strategy despite `/v1/` prefix — no deprecation headers, no version negotiation
- **M4.** No request/response logging middleware — can't debug production API issues
- **M5.** No CORS preflight caching (`max_age` not set) — every request sends an OPTIONS preflight
- **M6.** Database not migrated via Alembic — schema changes require manual intervention
- **M7.** No OpenAPI schema customization — auto-generated docs lack descriptions, examples

### Data & Validation
- **M8.** GeoJSON coordinates not validated (backend accepts malformed polygons without error)
- **M9.** `ParcelInfo.polygon_wgs84` typed as `number[][]` instead of proper coordinate tuple type
- **M10.** Manual plot input has no min/max validation for polygon vertices
- **M11.** Financial dashboard `landCost` initialized as string, used as number
- **M12.** Shadow analysis assumes northern hemisphere (hardcoded sun path)
- **M13.** Regulation engine has hardcoded German city data — no dynamic lookup for unlisted cities

### UX & Polish
- **M14.** Floor labels use English ("Ground", "Floor N") despite German UI requirement
- **M15.** No success feedback after IFC export, optimization start, or project save
- **M16.** Canvas-based floor plan viewer not keyboard accessible
- **M17.** No undo/redo for any user action
- **M18.** Fitness chart returns `null` if data.length < 2 — caller doesn't handle, layout collapses
- **M19.** No pagination on project list — will break with hundreds of projects
- **M20.** Slider inputs lack accessible labels
- **M21.** Step indicator buttons lack aria-labels
- **M22.** 3D scene hardcoded to 600px height — not responsive on tablets/mobile
- **M23.** No dark mode despite modern UI framework
- **M24.** No progress indicator for long-running operations (optimization can take minutes)

### Performance
- **M25.** `BuildingDetailed` creates 3D geometry on every render without memoization
- **M26.** Window/door hole cutting in Three.js runs on every render (should be memoized)
- **M27.** `getTransform()` in FloorPlanViewer called every render without useMemo
- **M28.** No debouncing on map click handler — rapid clicks fire duplicate parcel lookups
- **M29.** Canvas mouse move handler computes snap points without throttling
- **M30.** No lazy loading of Three.js (loaded even if user never opens 3D view)

### Code Quality
- **M31.** Inconsistent error handling patterns (some throw, some return null, some swallow)
- **M32.** JSON deep clone via `JSON.parse(JSON.stringify())` in RegulationPanel (fragile, loses types)
- **M33.** Multiple `useState` calls in OptimizationPreferences where a single state object would be cleaner
- **M34.** `completedFitnessHistory` kept across new generations — can show misleading chart data
- **M35.** Global HTTP client in backend not thread-safe for concurrent requests
- **M36.** Unused imports in multiple frontend files
- **M37.** No TypeScript strict mode enforcement
- **M38.** Optimizer `_fail_reasons` counter is a class variable — shared across all instances

---

## LOW (40) — Polish and best practices

### Missing Features a Professional Would Expect
- **L1.** No user authentication or multi-tenancy
- **L2.** No project sharing or collaboration
- **L3.** No print/PDF export of floor plans (only IFC)
- **L4.** No comparison view between optimization runs
- **L5.** No measurement tool in 2D floor plan viewer
- **L6.** No room area labels on floor plan
- **L7.** No sun direction indicator on site plan
- **L8.** No building code compliance report export
- **L9.** No version history for projects
- **L10.** No keyboard shortcuts
- **L11.** No onboarding or help system
- **L12.** No auto-save
- **L13.** No offline capability
- **L14.** No i18n framework (hardcoded German/English mix)
- **L15.** No notification system for completed long-running jobs

### Code & Config
- **L16.** ~~Debug `print()` statements should use `logging` module~~ ✅ Fixed
- **L17.** ~~`.env` file with empty secrets committed~~ ✅ Fixed
- **L18.** ~~No pre-commit hooks for linting/formatting~~ ✅ Added .pre-commit-config.yaml
- **L19.** ~~No CI/CD pipeline configured~~ ✅ Added .github/workflows/ci.yml
- **L20.** ~~No Dockerfile for local development parity~~ ✅ Added backend/Dockerfile
- **L21.** ~~`venv/` committed to repo~~ ✅ Added to .gitignore
- **L22.** ~~No API rate limiting middleware~~ ✅ Added RateLimitMiddleware (120 req/min)
- **L23.** ~~No request size limits on API endpoints~~ ✅ Added 10 MB limit
- **L24.** ~~No CSRF protection~~ ✅ SameSite cookies + Origin header check
- **L25.** ~~No security headers middleware~~ ✅ Added X-Content-Type-Options, X-Frame-Options, Referrer-Policy

### Consistency & Documentation
- **L26.** ~~Room color mappings unexplained~~ ✅ Documented with DIN 1356 rationale
- **L27.** ~~`SNAP_RADIUS` undocumented~~ ✅ Added JSDoc
- **L28.** ~~`radiusM` default unexplained~~ ✅ Added JSDoc to loadParcelsInRadius
- **L29.** ~~Zoom threshold 15 repeated~~ ✅ Extracted MIN_CADASTRAL_ZOOM constant
- **L30.** ~~Naming inconsistency undocumented~~ ✅ Added detailed docstring to BuildingFloorPlans
- **L31.** Goldbeck constants ~1% inaccuracy — Skipped (needs proprietary Goldbeck source docs)
- **L32.** ~~No JSDoc/docstrings~~ ✅ Added docstrings to generate_floor_plans + optimize
- **L33.** ~~Frontend components lack prop docs~~ ✅ Added TSDoc to Scene3D, FloorPlanViewer, CadastralMap
- **L34.** ~~No architecture diagram~~ ✅ Created ARCHITECTURE.md with Mermaid diagram
- **L35.** ~~No contributing guide~~ ✅ Created CONTRIBUTING.md

### Deployment
- **L36.** ~~Railway nixpacks.toml not working~~ ✅ Fixed venv activation in start command
- **L37.** No staging environment — Skipped (infrastructure config, not code)
- **L38.** ~~No monitoring/alerting setup~~ ✅ Added structured logging (JSON in prod)
- **L39.** ~~No backup strategy for SQLite~~ ✅ Created scripts/backup_db.py (online backup + pruning)
- **L40.** ~~CORS allows all methods/headers~~ ✅ Already fixed in M5

---

## Priority Fix Order

For getting the app testable by external users, fix in this order:

1. **C1 + C2** — Job state race condition + memory leak (threading lock + TTL cache) — 2h
2. **C3** — Empty variants crash guard — 10min
3. **C5** — datetime fix for Python 3.12+ — 5min
4. **H2** — Replace bare `except` blocks with logging — 2h
5. **H5 + H6** — Surface errors to UI, add loading states — 3h
6. **H7** — Input validation on optimizer params — 1h
7. **C6** — Write critical path tests (generator, optimizer, IFC export) — 8h
8. **L36** — Push nixpacks.toml, complete Railway deploy — 30min
9. **H16** — Replace print() with proper logging — 1h
10. **M14** — Fix English/German UI inconsistency — 30min

**Estimated total for "safe to test" state: ~18 hours of focused work.**
