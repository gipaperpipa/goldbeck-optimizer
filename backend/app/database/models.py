"""
SQLAlchemy ORM models for the Goldbeck parcel database.

Geometry is stored as GeoJSON text (JSON string) in SQLite.
Spatial operations use Shapely in Python.
When migrating to PostgreSQL + PostGIS, swap geometry columns to
proper PostGIS Geometry types.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import DeclarativeBase, relationship


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# ═══════════════════════════════════════════════════════════════════
# PARCELS
# ═══════════════════════════════════════════════════════════════════

class Parcel(Base):
    """
    A cadastral parcel (Flurstück). Immutable geometry from WFS.
    Every parcel ever fetched or clicked gets stored permanently.
    """
    __tablename__ = "parcels"

    id = Column(String, primary_key=True, default=_uuid)
    cadastral_ref = Column(String, unique=True, nullable=True, index=True)
    state = Column(String, nullable=False, default="")
    gemarkung = Column(String, default="")
    flur_nr = Column(String, default="")
    flurstueck_nr = Column(String, default="")

    # Geometry stored as GeoJSON string: {"type":"Polygon","coordinates":[[[lng,lat],...]]}
    geometry_geojson = Column(Text, nullable=True)
    area_sqm = Column(Float, default=0.0)
    centroid_lng = Column(Float, nullable=True, index=True)
    centroid_lat = Column(Float, nullable=True, index=True)

    address_hint = Column(String, default="")
    source = Column(String, default="")  # bkg_wfs, state_wfs, overpass, manual
    raw_properties = Column(Text, default="{}")  # JSON blob

    fetched_at = Column(DateTime, default=_now)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    # Relationships
    metadata_rel = relationship("ParcelMetadata", back_populates="parcel", uselist=False, cascade="all, delete-orphan")
    contacts = relationship("ParcelContact", back_populates="parcel", cascade="all, delete-orphan")
    project_links = relationship("ProjectParcel", back_populates="parcel", cascade="all, delete-orphan")
    timeline_entries = relationship("TimelineEntry", back_populates="parcel", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_parcel_centroid", "centroid_lng", "centroid_lat"),
    )


class ParcelMetadata(Base):
    """
    User-entered data about a parcel.
    Separated from Parcel because geometry is objective (WFS)
    while metadata is subjective (user-entered).
    """
    __tablename__ = "parcel_metadata"

    parcel_id = Column(String, ForeignKey("parcels.id", ondelete="CASCADE"), primary_key=True)

    # Bebauungsplan
    bebauungsplan_nr = Column(String, default="")
    bebauungsplan_url = Column(String, default="")
    bebauungsplan_notes = Column(Text, default="")

    # Zoning
    zoning_type = Column(String, default="")  # WR, WA, MI, MK, GE, etc.
    grz = Column(Float, nullable=True)
    gfz = Column(Float, nullable=True)
    max_height_m = Column(Float, nullable=True)
    max_stories = Column(Integer, nullable=True)
    bauweise = Column(String, default="")  # offen / geschlossen
    dachform = Column(String, default="")
    noise_zone = Column(String, default="")

    # Commercial
    asking_price_eur = Column(Float, nullable=True)
    price_per_sqm = Column(Float, nullable=True)
    status = Column(String, default="available")  # available, under_negotiation, acquired, rejected

    notes = Column(Text, default="")
    updated_at = Column(DateTime, default=_now, onupdate=_now)
    updated_by = Column(String, nullable=True)

    parcel = relationship("Parcel", back_populates="metadata_rel")


# ═══════════════════════════════════════════════════════════════════
# CONTACTS
# ═══════════════════════════════════════════════════════════════════

class Contact(Base):
    """A person or organization (seller, agent, planner, authority)."""
    __tablename__ = "contacts"

    id = Column(String, primary_key=True, default=_uuid)
    org_id = Column(String, ForeignKey("organizations.id"), nullable=True)
    type = Column(String, default="other")  # seller, agent, planner, authority, lawyer, other
    name = Column(String, nullable=False, default="")
    company = Column(String, default="")
    email = Column(String, default="")
    phone = Column(String, default="")
    address = Column(String, default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=_now)

    parcel_links = relationship("ParcelContact", back_populates="contact", cascade="all, delete-orphan")
    timeline_entries = relationship("TimelineEntry", back_populates="contact", cascade="all, delete-orphan")


class ParcelContact(Base):
    """Links a contact to a parcel with a role."""
    __tablename__ = "parcel_contacts"

    parcel_id = Column(String, ForeignKey("parcels.id", ondelete="CASCADE"), primary_key=True)
    contact_id = Column(String, ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True)
    role = Column(String, default="")  # seller, listing_agent, building_authority, neighbor
    notes = Column(Text, default="")

    parcel = relationship("Parcel", back_populates="contacts")
    contact = relationship("Contact", back_populates="parcel_links")


# ═══════════════════════════════════════════════════════════════════
# PROJECTS
# ═══════════════════════════════════════════════════════════════════

class Project(Base):
    """A development project involving one or more parcels."""
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=_uuid)
    org_id = Column(String, ForeignKey("organizations.id"), nullable=True)
    name = Column(String, nullable=False, default="")
    description = Column(Text, default="")
    status = Column(String, default="prospecting")
    # prospecting, negotiating, planning, approved, under_construction, completed, abandoned
    address = Column(String, default="")
    target_units = Column(Integer, nullable=True)
    target_gfz_usage = Column(Float, nullable=True)
    budget_eur = Column(Float, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)
    created_by = Column(String, nullable=True)

    parcel_links = relationship("ProjectParcel", back_populates="project", cascade="all, delete-orphan")
    optimization_runs = relationship("OptimizationRun", back_populates="project", cascade="all, delete-orphan")
    timeline_entries = relationship("TimelineEntry", back_populates="project", cascade="all, delete-orphan")


class ProjectParcel(Base):
    """M:N link between projects and parcels."""
    __tablename__ = "project_parcels"

    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    parcel_id = Column(String, ForeignKey("parcels.id", ondelete="CASCADE"), primary_key=True)
    role = Column(String, default="main")  # main, adjacent, access_road, future_expansion
    added_at = Column(DateTime, default=_now)

    project = relationship("Project", back_populates="parcel_links")
    parcel = relationship("Parcel", back_populates="project_links")


class OptimizationRun(Base):
    """Every Goldbeck optimizer run, linked to a project."""
    __tablename__ = "optimization_runs"

    id = Column(String, primary_key=True, default=_uuid)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    config_json = Column(Text, default="{}")  # Building type, constraints
    fitness_scores_json = Column(Text, default="{}")
    best_fitness = Column(Float, nullable=True)
    layout_data_json = Column(Text, default="{}")
    ifc_file_path = Column(String, default="")
    duration_seconds = Column(Float, nullable=True)
    generations = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_now)

    project = relationship("Project", back_populates="optimization_runs")


# ═══════════════════════════════════════════════════════════════════
# TIMELINE (CRM BACKBONE)
# ═══════════════════════════════════════════════════════════════════

class TimelineEntry(Base):
    """Activity log for parcels, projects, and contacts."""
    __tablename__ = "timeline_entries"

    id = Column(String, primary_key=True, default=_uuid)
    org_id = Column(String, nullable=True)
    parcel_id = Column(String, ForeignKey("parcels.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(String, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    contact_id = Column(String, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    type = Column(String, default="note")
    # call, email, meeting, site_visit, note, status_change, document, offer
    title = Column(String, default="")
    description = Column(Text, default="")
    attachments_json = Column(Text, default="[]")  # JSON array of file paths/URLs
    event_date = Column(DateTime, default=_now)
    created_at = Column(DateTime, default=_now)
    created_by = Column(String, nullable=True)

    parcel = relationship("Parcel", back_populates="timeline_entries")
    project = relationship("Project", back_populates="timeline_entries")
    contact = relationship("Contact", back_populates="timeline_entries")


# ═══════════════════════════════════════════════════════════════════
# MULTI-TENANCY (FUTURE)
# ═══════════════════════════════════════════════════════════════════

class Organization(Base):
    __tablename__ = "organizations"

    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False, default="")
    plan = Column(String, default="free")  # free, pro, enterprise
    created_at = Column(DateTime, default=_now)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_uuid)
    org_id = Column(String, ForeignKey("organizations.id"), nullable=True)
    email = Column(String, unique=True, nullable=False)
    name = Column(String, default="")
    role = Column(String, default="owner")  # owner, admin, member, viewer
    created_at = Column(DateTime, default=_now)


# ═══════════════════════════════════════════════════════════════════
# EDITED FLOOR PLANS (Phase 3.7c — cross-device sync)
# ═══════════════════════════════════════════════════════════════════

class EditedFloorPlan(Base):
    """
    A user-edited copy of a single FloorPlan (one storey of one building),
    persisted server-side so edits sync across devices and survive browser
    cache clears. Paired with the Zustand localStorage cache (Phase 3.7b) —
    localStorage provides instant offline UX while this table is the source
    of truth on cold start / new device.

    Staleness detection:
      - `original_fingerprint` is the hash of the plan BEFORE any user
        edits (computed on the client via FNV-1a over sorted UUIDs etc.)
      - When the optimizer regenerates a plan, new UUIDs → new fingerprint
      - On load, the client compares the live plan's fingerprint against
        this column; mismatch → the stored edit is stale, discard.
    """
    __tablename__ = "edited_floor_plans"

    id = Column(String, primary_key=True, default=_uuid)
    # Composite natural key — a given (building, floor) has at most one
    # edit record. Not tied to Project/OptimizationRun yet (the building_id
    # is a client-generated identifier from the optimizer output); once we
    # wire up per-user auth we'll add user_id + unique(user_id, building_id, floor_index).
    building_id = Column(String, nullable=False, index=True)
    floor_index = Column(Integer, nullable=False)
    original_fingerprint = Column(String, nullable=False)
    plan_json = Column(Text, nullable=False)  # serialized FloorPlan
    saved_at = Column(DateTime, default=_now, onupdate=_now)
    created_at = Column(DateTime, default=_now)

    __table_args__ = (
        UniqueConstraint("building_id", "floor_index", name="uq_edit_building_floor"),
        Index("idx_edit_building_floor", "building_id", "floor_index"),
    )
