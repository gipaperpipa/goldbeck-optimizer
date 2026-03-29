"""
Async SQLAlchemy engine for SQLite (aiosqlite).

Usage:
    from app.database.engine import get_db, init_db

    # At startup:
    await init_db()

    # In endpoints:
    async with get_db() as session:
        ...
"""

import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database.models import Base

# ── Configuration ──────────────────────────────────────────────────

_DB_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
_DB_PATH = os.path.join(_DB_DIR, "goldbeck.db")
_DB_URL = f"sqlite+aiosqlite:///{os.path.abspath(_DB_PATH)}"

_engine = create_async_engine(
    _DB_URL,
    echo=False,
    # SQLite needs this for concurrent access
    connect_args={"check_same_thread": False},
)

_session_factory = async_sessionmaker(
    _engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# ── Public API ─────────────────────────────────────────────────────

async def init_db() -> None:
    """Create all tables if they don't exist. Call once at app startup."""
    os.makedirs(_DB_DIR, exist_ok=True)
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db() -> None:
    """Dispose engine connections. Call at app shutdown."""
    await _engine.dispose()


@asynccontextmanager
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional async session scope."""
    async with _session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
