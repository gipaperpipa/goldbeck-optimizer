#!/usr/bin/env python3
"""SQLite online backup utility for the Goldbeck Optimizer database.

Uses SQLite's built-in backup API (safe even while the app is running
with WAL mode).  Keeps the last N backups and removes older ones.

Usage:
    python scripts/backup_db.py                  # backup to data/backups/
    python scripts/backup_db.py --keep 14        # keep last 14 backups
    python scripts/backup_db.py --dest /mnt/bak  # custom destination
"""

import argparse
import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "goldbeck.db"
DEFAULT_BACKUP_DIR = Path(__file__).resolve().parent.parent / "data" / "backups"
DEFAULT_KEEP = 7


def backup(db_path: Path, dest_dir: Path, keep: int) -> Path:
    """Perform an online backup and prune old backups.

    Args:
        db_path: Path to the live SQLite database.
        dest_dir: Directory to store backup files.
        keep: Number of recent backups to retain.

    Returns:
        Path to the new backup file.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = dest_dir / f"goldbeck_{timestamp}.db"

    # Use SQLite's online backup API (safe with WAL)
    src = sqlite3.connect(str(db_path))
    dst = sqlite3.connect(str(backup_path))
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    size_mb = backup_path.stat().st_size / (1024 * 1024)
    print(f"Backup created: {backup_path} ({size_mb:.1f} MB)")

    # Prune old backups
    backups = sorted(dest_dir.glob("goldbeck_*.db"))
    if len(backups) > keep:
        for old in backups[: len(backups) - keep]:
            old.unlink()
            print(f"Removed old backup: {old.name}")

    return backup_path


def main():
    parser = argparse.ArgumentParser(description="Backup the Goldbeck SQLite database")
    parser.add_argument("--dest", type=Path, default=DEFAULT_BACKUP_DIR, help="Backup directory")
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP, help="Number of backups to keep")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"Database not found at {DB_PATH}")
        raise SystemExit(1)

    backup(DB_PATH, args.dest, args.keep)


if __name__ == "__main__":
    main()
