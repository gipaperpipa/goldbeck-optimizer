import json

from app.config import settings
from app.models.regulation import RegulationSet, RegulationLookupResponse


async def lookup_regulations(
    address: str,
    city: str | None = None,
    state: str | None = None,
) -> RegulationLookupResponse:
    """Use AI to research zoning regulations for a given address."""

    if not settings.anthropic_api_key:
        # Return sensible defaults when no API key is configured
        return RegulationLookupResponse(
            regulations=RegulationSet(),
            confidence=0.3,
            source_description="Default values (no AI API key configured)",
            notes=[
                "No Anthropic API key configured. Using default R-3 zoning values.",
                "Please configure ANTHROPIC_API_KEY in backend/.env for AI-powered lookup.",
            ],
        )

    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    location_desc = address
    if city:
        location_desc += f", {city}"
    if state:
        location_desc += f", {state}"

    prompt = f"""Research the zoning regulations for a residential apartment building at or near this address: {location_desc}

Provide the most likely zoning parameters as a JSON object with these fields (all measurements in METERS and SQUARE METERS):
- zoning_type: string (e.g., "R-3", "R-4", "RM-5", etc.)
- max_far: number (Floor Area Ratio)
- max_height_m: number (in meters)
- max_stories: integer
- max_lot_coverage_pct: number (0-100)
- min_open_space_pct: number (0-100)
- setbacks: object with front_m, rear_m, side_left_m, side_right_m (all in meters)
- parking_studio_ratio: number (spaces per studio unit)
- parking_one_bed_ratio: number
- parking_two_bed_ratio: number
- parking_three_bed_ratio: number
- fire_access_width_m: number (in meters)
- min_building_separation_m: number (in meters)
- confidence: number (0-1, your confidence in these values)
- notes: array of strings (caveats, sources, important notes)
- source_description: string (what sources/knowledge you used)

Respond with ONLY the JSON object, no other text."""

    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    try:
        response_text = message.content[0].text.strip()
        # Remove potential markdown code block wrapper
        if response_text.startswith("```"):
            response_text = response_text.split("\n", 1)[1]
            response_text = response_text.rsplit("```", 1)[0]

        data = json.loads(response_text)

        regs = RegulationSet(
            zoning_type=data.get("zoning_type", "R-3"),
            max_far=data.get("max_far", 1.5),
            max_height_m=data.get("max_height_m", 13.72),  # default 45 ft ≈ 13.72 m
            max_stories=data.get("max_stories", 3),
            max_lot_coverage_pct=data.get("max_lot_coverage_pct", 50),
            min_open_space_pct=data.get("min_open_space_pct", 25),
            fire_access_width_m=data.get("fire_access_width_m", 6.10),  # default 20 ft ≈ 6.10 m
            min_building_separation_m=data.get("min_building_separation_m", 4.57),  # default 15 ft ≈ 4.57 m
        )

        if "setbacks" in data:
            s = data["setbacks"]
            regs.setbacks.front_m = s.get("front_m", 6.10)  # default 20 ft ≈ 6.10 m
            regs.setbacks.rear_m = s.get("rear_m", 4.57)    # default 15 ft ≈ 4.57 m
            regs.setbacks.side_left_m = s.get("side_left_m", 3.05)   # default 10 ft ≈ 3.05 m
            regs.setbacks.side_right_m = s.get("side_right_m", 3.05)  # default 10 ft ≈ 3.05 m

        if "parking_studio_ratio" in data:
            regs.parking.studio_ratio = data["parking_studio_ratio"]
            regs.parking.one_bed_ratio = data.get("parking_one_bed_ratio", 1.0)
            regs.parking.two_bed_ratio = data.get("parking_two_bed_ratio", 1.5)
            regs.parking.three_bed_ratio = data.get("parking_three_bed_ratio", 2.0)

        return RegulationLookupResponse(
            regulations=regs,
            confidence=data.get("confidence", 0.5),
            source_description=data.get("source_description", "AI-researched zoning parameters"),
            notes=data.get("notes", []),
        )
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        return RegulationLookupResponse(
            regulations=RegulationSet(),
            confidence=0.2,
            source_description="AI lookup failed to parse response",
            notes=[f"Error parsing AI response: {str(e)}", "Using default values."],
        )
