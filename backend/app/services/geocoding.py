import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Default fallback: Frankfurt am Main (central Germany)
_DEFAULT_CENTROID = {"lng": 8.6821, "lat": 50.1109}

# M35: Reuse a single AsyncClient for connection pooling
_http_client: Optional[httpx.AsyncClient] = None


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0),
        )
    return _http_client


async def geocode_address(address: str) -> dict | None:
    """Geocode an address using Mapbox Geocoding API. Returns {lng, lat} or None."""
    if not settings.mapbox_token:
        logger.warning("No Mapbox token configured, using Frankfurt default")
        return _DEFAULT_CENTROID.copy()

    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{address}.json"
    params = {
        "access_token": settings.mapbox_token,
        "limit": 1,
        "country": "DE",
    }

    client = _get_http_client()
    response = await client.get(url, params=params)
    response.raise_for_status()
    data = response.json()

    features = data.get("features", [])
    if not features:
        return None

    coords = features[0]["geometry"]["coordinates"]
    return {"lng": coords[0], "lat": coords[1]}
