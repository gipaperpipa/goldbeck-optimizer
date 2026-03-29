# Goldbeck Optimizer — Parcel Database & Project Platform

## System Architecture

### Overview
The system evolves from a simple floor plan optimizer into a **parcel-centric development platform** with three core layers:

1. **Parcel Engine** — Reliable cadastral data loading, caching, and persistent storage
2. **Project Manager** — Parcels grouped into development projects with contacts, timelines, and optimizer runs
3. **Dashboard** — Map-based overview of all parcels, projects, feasibility comparisons, and sales pipeline

### The Key Insight: Cache-First Parcel Loading

The #1 problem today is that German state WFS services are unreliable (403 errors, timeouts, missing data). The fix is to **never depend on live WFS queries for the user experience**:

```
User searches address
       ↓
Backend checks local DB for parcels within radius
       ↓
  Found in DB? ──→ YES → Serve instantly from DB (< 50ms)
       ↓ NO
  Fetch from BKG WFS (federal, most reliable)
       ↓ FAIL?
  Fetch from State WFS (16 state-specific endpoints)
       ↓ FAIL?
  Fetch from Overpass API (OSM landuse polygons)
       ↓
  Store ALL fetched parcels in local DB
       ↓
  Return to frontend + trigger background job
  to load remaining parcels in wider radius
```

**Result**: First load might take 2-3 seconds. Every subsequent visit to the same area is instant. Over time, the database becomes a comprehensive cadastral mirror of every area you've ever looked at.

---

## Data Model

### parcels
The core entity. Every parcel ever encountered gets stored permanently.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Internal ID |
| cadastral_ref | TEXT UNIQUE | National cadastral reference (from WFS `nationalCadastralReference`) |
| state | TEXT | Bundesland |
| gemarkung | TEXT | Gemarkung name |
| flur_nr | TEXT | Flur number |
| flurstueck_nr | TEXT | Flurstück number |
| geometry | GEOMETRY(Polygon, 4326) | PostGIS polygon in WGS84 |
| area_sqm | FLOAT | Computed from geometry |
| centroid_lng | FLOAT | For fast spatial lookups |
| centroid_lat | FLOAT | For fast spatial lookups |
| address_hint | TEXT | Nearest known address |
| source | TEXT | Where we got it (bkg_wfs, state_wfs, overpass, manual) |
| raw_properties | JSONB | Full WFS properties for reference |
| fetched_at | TIMESTAMP | When we loaded it from WFS |
| created_at | TIMESTAMP | First time we stored it |
| updated_at | TIMESTAMP | Last modification |

**Spatial index**: `CREATE INDEX idx_parcels_geom ON parcels USING GIST (geometry);`

### parcel_metadata
User-entered data about a parcel. Separated from `parcels` because parcel geometry is objective (from WFS) while metadata is subjective (user input).

| Column | Type | Description |
|--------|------|-------------|
| parcel_id | UUID (FK → parcels) PK | |
| bebauungsplan_nr | TEXT | B-Plan number |
| bebauungsplan_url | TEXT | Link to PDF/portal |
| bebauungsplan_notes | TEXT | Free-text notes |
| zoning_type | TEXT | WR, WA, MI, MK, GE, etc. |
| grz | FLOAT | Grundflächenzahl |
| gfz | FLOAT | Geschossflächenzahl |
| max_height_m | FLOAT | Max building height |
| max_stories | INT | Max number of stories |
| bauweise | TEXT | offen / geschlossen |
| dachform | TEXT | Roof type constraints |
| noise_zone | TEXT | Lärmschutzzone |
| asking_price_eur | FLOAT | Listed or communicated price |
| price_per_sqm | FLOAT | Computed or manual |
| status | TEXT | available / under_negotiation / acquired / rejected |
| notes | TEXT | General notes |
| updated_at | TIMESTAMP | |
| updated_by | UUID (FK → users) | |

### contacts
People and organizations related to parcels and projects.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| org_id | UUID (FK → organizations) | Multi-tenancy |
| type | ENUM | seller, agent, planner, authority, lawyer, other |
| name | TEXT | Full name |
| company | TEXT | Company/organization |
| email | TEXT | |
| phone | TEXT | |
| address | TEXT | |
| notes | TEXT | |
| created_at | TIMESTAMP | |

### parcel_contacts
Links contacts to parcels with a role.

| Column | Type | Description |
|--------|------|-------------|
| parcel_id | UUID (FK) | |
| contact_id | UUID (FK) | |
| role | TEXT | seller, listing_agent, building_authority, neighbor, etc. |
| notes | TEXT | |

### projects
A development project involving one or more parcels.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| org_id | UUID (FK → organizations) | Multi-tenancy |
| name | TEXT | e.g., "Saarburg Wohnanlage" |
| description | TEXT | |
| status | ENUM | prospecting, negotiating, planning, approved, under_construction, completed, abandoned |
| address | TEXT | Primary address |
| target_units | INT | Target number of apartments |
| target_gfz_usage | FLOAT | How much of allowed GFZ to use |
| budget_eur | FLOAT | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |
| created_by | UUID (FK → users) | |

### project_parcels
Many-to-many: a parcel can be in multiple projects, a project uses multiple parcels.

| Column | Type | Description |
|--------|------|-------------|
| project_id | UUID (FK) | |
| parcel_id | UUID (FK) | |
| role | TEXT | main, adjacent, access_road, future_expansion |
| added_at | TIMESTAMP | |

### optimization_runs
Every Goldbeck optimizer run, linked to a project.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| project_id | UUID (FK) | |
| config | JSONB | Building type, constraints, parameters |
| fitness_scores | JSONB | All 17 criteria scores |
| best_fitness | FLOAT | Overall best fitness |
| layout_data | JSONB | Full floorplan layout |
| ifc_file_path | TEXT | Path to exported IFC file |
| duration_seconds | FLOAT | How long the optimization ran |
| generations | INT | Number of GA generations |
| created_at | TIMESTAMP | |

### timeline_entries
Activity log for parcels, projects, and contacts. The CRM backbone.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| org_id | UUID (FK → organizations) | |
| parcel_id | UUID (FK, nullable) | |
| project_id | UUID (FK, nullable) | |
| contact_id | UUID (FK, nullable) | |
| type | ENUM | call, email, meeting, site_visit, note, status_change, document, offer |
| title | TEXT | Short summary |
| description | TEXT | Full details |
| attachments | JSONB | File paths/URLs |
| event_date | TIMESTAMP | When it happened |
| created_at | TIMESTAMP | When it was logged |
| created_by | UUID (FK → users) | |

### users & organizations (multi-tenancy)

**organizations**
| Column | Type |
|--------|------|
| id | UUID (PK) |
| name | TEXT |
| plan | ENUM (free, pro, enterprise) |
| created_at | TIMESTAMP |

**users**
| Column | Type |
|--------|------|
| id | UUID (PK) |
| org_id | UUID (FK → organizations) |
| email | TEXT UNIQUE |
| name | TEXT |
| role | ENUM (owner, admin, member, viewer) |
| created_at | TIMESTAMP |

---

## Frontend Architecture

### Views

1. **Map View** (default) — Full-screen map of Germany
   - Address search bar (Nominatim geocoding)
   - Radius selector (250m, 500m, 1km, 2km)
   - All parcels in radius rendered as vectors with color coding:
     - Gray outline = loaded from WFS, no user data
     - Blue fill = selected / in a project
     - Green fill = acquired
     - Red fill = rejected
     - Amber fill = under negotiation
   - Click parcel → side panel with all parcel info
   - Multi-select parcels → "Create Project" button
   - Toggle: show only "my parcels" vs all cached parcels

2. **Parcel Detail Panel** (side panel on map)
   - Cadastral info (auto-filled from WFS)
   - Bebauungsplan section (user-entered)
   - Contacts list (add/link contacts)
   - Projects this parcel belongs to
   - Timeline (communication log)
   - Quick actions: "Run Optimizer", "Export IFC"

3. **Projects Dashboard** — Table/kanban of all projects
   - Filter by status, state, date
   - Each card shows: name, location, # parcels, total area, status, last activity
   - Click → project detail view

4. **Project Detail View**
   - Map showing project parcels
   - Parcel list with metadata
   - Optimization runs history
   - Financial model (future)
   - Timeline / activity feed
   - Contacts involved

5. **Sales Dashboard** (future)
   - Pipeline view: prospecting → negotiating → planning → approved → construction
   - Revenue projections per project
   - Comparison matrix across projects

---

## API Endpoints (new/modified)

### Parcels
```
GET    /api/v1/parcels/in-radius?lng=&lat=&radius_m=500
       → Returns parcels from DB + triggers background WFS fetch if area is new

GET    /api/v1/parcels/{id}
       → Full parcel with metadata, contacts, projects

PUT    /api/v1/parcels/{id}/metadata
       → Update user-entered metadata (bebauungsplan, zoning, price, etc.)

POST   /api/v1/parcels/{id}/contacts
       → Link a contact to a parcel

GET    /api/v1/parcels/{id}/timeline
       → Activity log for this parcel
```

### Projects
```
GET    /api/v1/projects
       → List all projects (with filters)

POST   /api/v1/projects
       → Create project from selected parcels

GET    /api/v1/projects/{id}
       → Full project with parcels, runs, timeline

PUT    /api/v1/projects/{id}
       → Update project metadata

POST   /api/v1/projects/{id}/parcels
       → Add parcels to project

DELETE /api/v1/projects/{id}/parcels/{parcel_id}
       → Remove parcel from project

GET    /api/v1/projects/{id}/runs
       → Optimization run history

POST   /api/v1/projects/{id}/optimize
       → Trigger new optimization run
```

### Timeline
```
POST   /api/v1/timeline
       → Add timeline entry (linked to parcel/project/contact)

GET    /api/v1/timeline?parcel_id=&project_id=
       → Query timeline entries
```

### Contacts
```
GET    /api/v1/contacts
POST   /api/v1/contacts
PUT    /api/v1/contacts/{id}
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Database | PostgreSQL 16 + PostGIS 3.4 | Spatial queries, JSONB, proven at scale |
| ORM | SQLAlchemy 2.0 + GeoAlchemy2 | Async support, PostGIS integration |
| Migrations | Alembic | Schema versioning |
| Backend | FastAPI (existing) | Already in place, async-native |
| Auth | JWT + OAuth2 (future) | Start with simple API keys |
| Frontend | Next.js + Mapbox GL JS (existing) | Already in place |
| State Mgmt | Zustand or React Context | Lightweight, good for map state |

### Migration Path
For immediate development, we can start with **SQLite + SpatiaLite** (zero setup) and migrate to PostgreSQL when ready for multi-user. The SQLAlchemy ORM layer makes this a config change.

---

## Implementation Phases

### Phase 1: Fix Parcel Loading + Basic Storage (1-2 weeks)
- Replace broken WMS with cache-first vector loading
- Set up SQLite + SpatiaLite database
- Store every fetched parcel permanently
- Radius-based loading (fetch all parcels in area, not one-by-one)
- Basic parcel detail panel with cadastral info

### Phase 2: Project Management (1-2 weeks)
- Create/edit projects from selected parcels
- Project list/dashboard view
- Link optimizer runs to projects
- Basic timeline (notes, status changes)

### Phase 3: Contacts & CRM (1 week)
- Contact management (CRUD)
- Link contacts to parcels and projects
- Communication timeline

### Phase 4: Bebauungsplan & Metadata (1 week)
- Parcel metadata form (zoning, GFZ, GRZ, etc.)
- Status tracking per parcel (available → negotiating → acquired)
- Color-coded parcels on map by status

### Phase 5: Multi-tenancy & Auth (1-2 weeks)
- PostgreSQL migration
- User accounts and organizations
- Role-based access
- API authentication

### Phase 6: Dashboards & Analytics (2 weeks)
- Sales pipeline view
- Feasibility comparison across projects
- Export reports
