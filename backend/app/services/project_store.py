"""
Project CRUD operations.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, and_, func, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database.engine import get_db
from app.database.models import (
    Project,
    ProjectParcel,
    Parcel,
    ParcelMetadata,
    OptimizationRun,
    TimelineEntry,
    Contact,
    ParcelContact,
)

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════
# PROJECT CRUD
# ═══════════════════════════════════════════════════════════════════

async def create_project(data: dict) -> dict:
    """Create a new project, optionally linking parcels."""
    async with get_db() as session:
        project = Project(
            name=data.get("name", "Unnamed Project"),
            description=data.get("description", ""),
            status=data.get("status", "prospecting"),
            address=data.get("address", ""),
            target_units=data.get("target_units"),
            budget_eur=data.get("budget_eur"),
        )
        session.add(project)
        await session.flush()

        # Link parcels if provided
        parcel_ids = data.get("parcel_ids", [])
        for pid in parcel_ids:
            link = ProjectParcel(
                project_id=project.id,
                parcel_id=pid,
                role="main",
            )
            session.add(link)

        # Add timeline entry
        entry = TimelineEntry(
            project_id=project.id,
            type="status_change",
            title="Project created",
            description=f"Project '{project.name}' created with {len(parcel_ids)} parcel(s).",
        )
        session.add(entry)

        return _project_to_dict(project, parcel_count=len(parcel_ids))


async def list_projects(status: Optional[str] = None) -> list[dict]:
    """List all projects with parcel counts."""
    async with get_db() as session:
        stmt = select(Project).order_by(Project.updated_at.desc())
        if status:
            stmt = stmt.where(Project.status == status)

        result = await session.execute(stmt)
        projects = result.scalars().all()

        output = []
        for p in projects:
            # Count parcels
            count_stmt = select(func.count(ProjectParcel.parcel_id)).where(
                ProjectParcel.project_id == p.id
            )
            count = (await session.execute(count_stmt)).scalar() or 0

            # Total area
            area_stmt = (
                select(func.sum(Parcel.area_sqm))
                .join(ProjectParcel, ProjectParcel.parcel_id == Parcel.id)
                .where(ProjectParcel.project_id == p.id)
            )
            total_area = (await session.execute(area_stmt)).scalar() or 0

            d = _project_to_dict(p, parcel_count=count)
            d["total_area_sqm"] = total_area
            output.append(d)

        return output


async def get_project_detail(project_id: str) -> Optional[dict]:
    """Get full project detail with parcels, runs, timeline."""
    async with get_db() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            return None

        d = _project_to_dict(project)

        # Load parcels
        parcel_stmt = (
            select(ProjectParcel, Parcel)
            .join(Parcel, ProjectParcel.parcel_id == Parcel.id)
            .where(ProjectParcel.project_id == project_id)
        )
        parcel_result = await session.execute(parcel_stmt)
        d["parcels"] = []
        total_area = 0.0
        for pp, parcel in parcel_result.all():
            pd = {
                "parcel_id": parcel.id,
                "cadastral_ref": parcel.cadastral_ref,
                "gemarkung": parcel.gemarkung,
                "flurstueck_nr": parcel.flurstueck_nr,
                "area_sqm": parcel.area_sqm,
                "role": pp.role,
                "centroid_lng": parcel.centroid_lng,
                "centroid_lat": parcel.centroid_lat,
            }
            # Add metadata status
            meta_stmt = select(ParcelMetadata).where(ParcelMetadata.parcel_id == parcel.id)
            meta_result = await session.execute(meta_stmt)
            meta = meta_result.scalar_one_or_none()
            if meta:
                pd["status"] = meta.status
                pd["zoning_type"] = meta.zoning_type
            d["parcels"].append(pd)
            total_area += parcel.area_sqm or 0

        d["total_area_sqm"] = total_area
        d["parcel_count"] = len(d["parcels"])

        # Load optimization runs
        runs_stmt = (
            select(OptimizationRun)
            .where(OptimizationRun.project_id == project_id)
            .order_by(OptimizationRun.created_at.desc())
            .limit(20)
        )
        runs_result = await session.execute(runs_stmt)
        d["optimization_runs"] = [
            {
                "id": r.id,
                "best_fitness": r.best_fitness,
                "generations": r.generations,
                "duration_seconds": r.duration_seconds,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in runs_result.scalars().all()
        ]

        # Load recent timeline
        timeline_stmt = (
            select(TimelineEntry)
            .where(TimelineEntry.project_id == project_id)
            .order_by(TimelineEntry.event_date.desc())
            .limit(50)
        )
        timeline_result = await session.execute(timeline_stmt)
        d["timeline"] = [
            {
                "id": t.id,
                "type": t.type,
                "title": t.title,
                "description": t.description,
                "event_date": t.event_date.isoformat() if t.event_date else None,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in timeline_result.scalars().all()
        ]

        return d


async def update_project(project_id: str, data: dict) -> Optional[dict]:
    """Update project fields."""
    async with get_db() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            return None

        old_status = project.status
        for key, value in data.items():
            if hasattr(project, key) and key not in ("id", "created_at"):
                setattr(project, key, value)
        project.updated_at = datetime.now(timezone.utc)

        # Log status change
        if "status" in data and data["status"] != old_status:
            entry = TimelineEntry(
                project_id=project_id,
                type="status_change",
                title=f"Status changed to {data['status']}",
                description=f"Status changed from '{old_status}' to '{data['status']}'.",
            )
            session.add(entry)

        return _project_to_dict(project)


async def add_parcel_to_project(project_id: str, parcel_id: str, role: str = "main") -> bool:
    """Add a parcel to a project."""
    async with get_db() as session:
        # Check if already linked
        stmt = select(ProjectParcel).where(
            and_(
                ProjectParcel.project_id == project_id,
                ProjectParcel.parcel_id == parcel_id,
            )
        )
        result = await session.execute(stmt)
        if result.scalar_one_or_none():
            return False  # Already linked

        link = ProjectParcel(
            project_id=project_id,
            parcel_id=parcel_id,
            role=role,
        )
        session.add(link)

        entry = TimelineEntry(
            project_id=project_id,
            parcel_id=parcel_id,
            type="note",
            title="Parcel added to project",
        )
        session.add(entry)

        return True


async def remove_parcel_from_project(project_id: str, parcel_id: str) -> bool:
    """Remove a parcel from a project."""
    async with get_db() as session:
        stmt = delete(ProjectParcel).where(
            and_(
                ProjectParcel.project_id == project_id,
                ProjectParcel.parcel_id == parcel_id,
            )
        )
        result = await session.execute(stmt)
        return result.rowcount > 0


# ═══════════════════════════════════════════════════════════════════
# TIMELINE
# ═══════════════════════════════════════════════════════════════════

async def add_timeline_entry(data: dict) -> dict:
    """Add a timeline entry."""
    async with get_db() as session:
        entry = TimelineEntry(
            parcel_id=data.get("parcel_id"),
            project_id=data.get("project_id"),
            contact_id=data.get("contact_id"),
            type=data.get("type", "note"),
            title=data.get("title", ""),
            description=data.get("description", ""),
            event_date=data.get("event_date", datetime.now(timezone.utc)),
        )
        session.add(entry)
        await session.flush()

        return {
            "id": entry.id,
            "type": entry.type,
            "title": entry.title,
            "description": entry.description,
            "event_date": entry.event_date.isoformat() if entry.event_date else None,
        }


async def get_timeline(
    parcel_id: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    """Query timeline entries."""
    async with get_db() as session:
        stmt = select(TimelineEntry).order_by(TimelineEntry.event_date.desc()).limit(limit)
        if parcel_id:
            stmt = stmt.where(TimelineEntry.parcel_id == parcel_id)
        if project_id:
            stmt = stmt.where(TimelineEntry.project_id == project_id)

        result = await session.execute(stmt)
        return [
            {
                "id": t.id,
                "type": t.type,
                "title": t.title,
                "description": t.description,
                "parcel_id": t.parcel_id,
                "project_id": t.project_id,
                "contact_id": t.contact_id,
                "event_date": t.event_date.isoformat() if t.event_date else None,
            }
            for t in result.scalars().all()
        ]


# ═══════════════════════════════════════════════════════════════════
# CONTACT CRUD
# ═══════════════════════════════════════════════════════════════════

async def create_contact(data: dict) -> dict:
    """Create a new contact."""
    async with get_db() as session:
        contact = Contact(
            type=data.get("type", "other"),
            name=data.get("name", ""),
            company=data.get("company", ""),
            email=data.get("email", ""),
            phone=data.get("phone", ""),
            address=data.get("address", ""),
            notes=data.get("notes", ""),
        )
        session.add(contact)
        await session.flush()
        return _contact_to_dict(contact)


async def list_contacts() -> list[dict]:
    """List all contacts."""
    async with get_db() as session:
        stmt = select(Contact).order_by(Contact.name)
        result = await session.execute(stmt)
        return [_contact_to_dict(c) for c in result.scalars().all()]


async def link_contact_to_parcel(parcel_id: str, contact_id: str, role: str = "") -> bool:
    """Link a contact to a parcel."""
    async with get_db() as session:
        link = ParcelContact(
            parcel_id=parcel_id,
            contact_id=contact_id,
            role=role,
        )
        session.add(link)
        return True


# ═══════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════

def _project_to_dict(p: Project, parcel_count: int = 0) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "status": p.status,
        "address": p.address,
        "target_units": p.target_units,
        "budget_eur": p.budget_eur,
        "parcel_count": parcel_count,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _contact_to_dict(c: Contact) -> dict:
    return {
        "id": c.id,
        "type": c.type,
        "name": c.name,
        "company": c.company,
        "email": c.email,
        "phone": c.phone,
        "address": c.address,
        "notes": c.notes,
    }
