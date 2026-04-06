# Contributing

## Prerequisites

- Python 3.11+
- Node.js 18+ with pnpm
- Git

## Setup

```bash
# Backend
cd backend
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
cd frontend
pnpm install
pnpm dev
```

The backend **must** be started from the `backend/` directory or you'll get `ModuleNotFoundError`.

## Code Style

- **Python**: Formatted and linted by [ruff](https://docs.astral.sh/ruff/). Run `ruff check . --fix && ruff format .` before committing.
- **TypeScript**: Standard React/Next.js conventions. Use TypeScript strict mode types — no `any` without justification.
- **UI text**: German where user-facing (e.g. "Flurstück", "Grundriss").

Pre-commit hooks are configured in `.pre-commit-config.yaml`. Install them:

```bash
pip install pre-commit
pre-commit install
```

## Branch & Commit Conventions

- Branch from `main` with descriptive names: `fix/overlapping-buildings`, `feat/staffelgeschoss`.
- Write commit messages in English, imperative mood: "Add Staffelgeschoss support" not "Added…".
- Keep commits focused — one logical change per commit.

## Architecture Notes

- See [ARCHITECTURE.md](ARCHITECTURE.md) for system diagrams and data flow.
- The generator uses a 7-phase pipeline (see `backend/app/services/floorplan/goldbeck_generator.py`).
- `BuildingFloorPlans.building_width_m` = generator's `length_m` (long facade). This naming mismatch is documented and intentional.
- Plan coordinates `(x, y)` map to Three.js as `(x, y_up, -y_plan)`. Wall rotation uses `angle` (not `-angle`).

## Running Tests

```bash
# Backend
cd backend
pytest

# Frontend
cd frontend
pnpm build  # type-checks + build
```

## Common Pitfalls

1. Don't use `--reload` with uvicorn during optimization — it kills background threads and loses jobs.
2. CORS is configured for localhost ports 3000–3002. Add new origins in `backend/app/config.py`.
3. The structural grid has per-floor dimensions for Staffelgeschoss support — don't assume all floors share the same grid.
