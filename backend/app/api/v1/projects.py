"""
Project API endpoints — CRUD, parcel linking, timeline, contacts.
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


# ── Models ────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    address: str = ""
    status: str = "prospecting"
    target_units: Optional[int] = None
    budget_eur: Optional[float] = None
    parcel_ids: list[str] = []


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    address: Optional[str] = None
    target_units: Optional[int] = None
    budget_eur: Optional[float] = None


class ParcelAdd(BaseModel):
    parcel_id: str
    role: str = "main"


class TimelineCreate(BaseModel):
    parcel_id: Optional[str] = None
    project_id: Optional[str] = None
    contact_id: Optional[str] = None
    type: str = "note"
    title: str = ""
    description: str = ""


class ContactCreate(BaseModel):
    type: str = "other"
    name: str = ""
    company: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    notes: str = ""


# ── Timeline Endpoints (before {project_id} catch-all) ────────────

@router.post("/timeline")
async def add_timeline(data: TimelineCreate):
    """Add a timeline entry."""
    from app.services.project_store import add_timeline_entry
    return await add_timeline_entry(data.model_dump())


@router.get("/timeline/entries")
async def get_timeline(
    parcel_id: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
):
    """Query timeline entries."""
    from app.services.project_store import get_timeline
    return await get_timeline(parcel_id, project_id, limit)


# ── Contact Endpoints ─────────────────────────────────────────────

@router.get("/contacts/all")
async def list_contacts():
    """List all contacts."""
    from app.services.project_store import list_contacts
    return await list_contacts()


@router.post("/contacts")
async def create_contact(data: ContactCreate):
    """Create a new contact."""
    from app.services.project_store import create_contact
    return await create_contact(data.model_dump())


# ── Project CRUD ──────────────────────────────────────────────────

@router.get("")
async def list_projects(status: Optional[str] = Query(None)):
    """List all projects."""
    from app.services.project_store import list_projects
    return await list_projects(status)


@router.post("")
async def create_project(data: ProjectCreate):
    """Create a new project, optionally linking parcels."""
    from app.services.project_store import create_project
    return await create_project(data.model_dump())


@router.get("/{project_id}")
async def get_project(project_id: str):
    """Get full project detail with parcels, runs, timeline."""
    from app.services.project_store import get_project_detail
    result = await get_project_detail(project_id)
    if not result:
        raise HTTPException(404, "Project not found")
    return result


@router.put("/{project_id}")
async def update_project(project_id: str, data: ProjectUpdate):
    """Update project fields."""
    from app.services.project_store import update_project
    update_dict = data.model_dump(exclude_none=True)
    result = await update_project(project_id, update_dict)
    if not result:
        raise HTTPException(404, "Project not found")
    return result


@router.post("/{project_id}/parcels")
async def add_parcel(project_id: str, data: ParcelAdd):
    """Add a parcel to a project."""
    from app.services.project_store import add_parcel_to_project
    added = await add_parcel_to_project(project_id, data.parcel_id, data.role)
    if not added:
        raise HTTPException(409, "Parcel already in project")
    return {"ok": True}


@router.delete("/{project_id}/parcels/{parcel_id}")
async def remove_parcel(project_id: str, parcel_id: str):
    """Remove a parcel from a project."""
    from app.services.project_store import remove_parcel_from_project
    removed = await remove_parcel_from_project(project_id, parcel_id)
    if not removed:
        raise HTTPException(404, "Link not found")
    return {"ok": True}
