# Deployment Guide

## Architecture

```
  Vercel (Frontend)              Railway (Backend)
  ┌──────────────┐              ┌──────────────────┐
  │  Next.js App │  ──REST──>   │  FastAPI + Python │
  │  React + 3D  │  <──JSON──   │  Optimizer + IFC  │
  └──────────────┘              │  WebSocket /ws    │
                                └──────────────────┘
```

## Step 1: Deploy Backend on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub Repo"**
3. Select the `gipaperpipa/goldbeck-optimizer` repo
4. Railway will auto-detect Python. Set the **root directory** to `backend`
5. Add environment variables in the Railway dashboard:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `FRONTEND_URL` = (set after Vercel deploys, e.g. `https://goldbeck.vercel.app`)
6. Railway auto-assigns a public URL like `https://goldbeck-api.up.railway.app`
7. Verify: visit `https://YOUR-RAILWAY-URL/api/health` — should return `{"status": "ok"}`

## Step 2: Deploy Frontend on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in
2. Click **"Add New Project"** → import `gipaperpipa/goldbeck-optimizer`
3. Set the **root directory** to `frontend`
4. Add environment variables:
   - `NEXT_PUBLIC_API_URL` = `https://YOUR-RAILWAY-URL/api` (from step 1)
   - `NEXT_PUBLIC_MAPBOX_TOKEN` = your Mapbox public token
5. Deploy — Vercel handles the rest

## Step 3: Connect CORS

1. Copy your Vercel deployment URL (e.g. `https://goldbeck.vercel.app`)
2. Go to Railway dashboard → your service → Variables
3. Set `FRONTEND_URL` = `https://goldbeck.vercel.app`
4. Railway will auto-redeploy with the updated CORS

## Environment Variables Summary

### Backend (Railway)
| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | For AI-assisted generation |
| `FRONTEND_URL` | Yes | Vercel URL for CORS |
| `MAPBOX_TOKEN` | No | For geocoding features |
| `DEBUG` | No | `true` for dev, defaults to `false` (production-safe) |
| `DATABASE_URL` | No | Override default SQLite path |
| `DB_DIR` | No | Directory for SQLite file (default: `./data/`) |
| `PORT` | Auto | Set by Railway automatically |

### Frontend (Vercel)
| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | Railway backend URL + `/api` |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Yes | Mapbox GL access token |

## Important Notes

- **SQLite on Railway**: Railway's filesystem is ephemeral — data in `./data/goldbeck.db` will be lost on redeploy. For persistent storage, attach a Railway volume to `/data` and set `DB_DIR=/data`. For now this is fine since the DB only caches parcel data.
- **Debug mode**: Defaults to `false` (production). Set `DEBUG=true` in Railway only for troubleshooting. This controls log format (JSON vs human-readable) and log level (INFO vs DEBUG).
- **Rate limiting**: 120 requests/minute per IP. Health check and docs endpoints are exempt.
- **Request size limit**: 10 MB max body size.

## Custom Domain (Optional)

- **Vercel**: Settings → Domains → add your domain
- **Railway**: Settings → Networking → add custom domain
- Update `FRONTEND_URL` on Railway if you change the frontend domain
