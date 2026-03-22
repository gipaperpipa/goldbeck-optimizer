import httpx

from app.config import settings


async def geocode_address(address: str) -> dict | None:
    """Geocode an address using Mapbox Geocoding API. Returns {lng, lat} or None."""
    if not settings.mapbox_token:
        # Return Denver as fallback when no token configured
        return {"lng": -104.9903, "lat": 39.7392}

    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{address}.json"
    params = {
        "access_token": settings.mapbox_token,
        "limit": 1,
        "country": "US",
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

    features = data.get("features", [])
    if not features:
        return None

    coords = features[0]["geometry"]["coordinates"]
    return {"lng": coords[0], "lat": coords[1]}
