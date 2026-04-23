/**
 * DIN 5034-1 Besonnung check (Phase 5g).
 *
 * DIN 5034-1:2011-09 "Tageslicht in Innenräumen" §4.3 requires that
 * on the reference day (**17. Januar**), at least one habitable-room
 * window per Wohnung receives at least **one hour of direct sunlight**
 * between 09:00 and 15:00 local solar time. It's the main planning-
 * phase sun-access check in Germany and is enforced by most NRW
 * Bauaufsichtsbehörden as part of the Bauvorlagen.
 *
 * This is a pure screening-level check:
 *
 *   1. Compute solar azimuth + altitude at the plot's latitude/longitude
 *      at 10-minute increments from 09:00 to 15:00 on Jan 17.
 *   2. For each window, compute its geographic-azimuth outward normal
 *      from its host wall's orientation + the building rotation.
 *   3. At each sample, a window is considered sunlit iff:
 *      - sun altitude > 0° (above horizon), AND
 *      - angle between sun azimuth and window normal ≤ 90° (window
 *        physically faces the sun — the sun can reach the glass).
 *   4. Per apartment, take the max sun-hours across all habitable-room
 *      windows. Thresholds:
 *        ≥ 1.0 h   → pass
 *        ≥ 0.5 h   → warn (marginal, below DIN but above 0)
 *        < 0.5 h   → fail (DIN 5034-1 violation, likely permit issue)
 *
 * ## What this module does NOT do
 *
 *   - No ray-cast against neighboring buildings / trees / terrain — a
 *     full shadow cast is the site-coordination 3D shadow analyzer's
 *     job. This module only answers "would the sun reach this window
 *     if the horizon were clear?" which is the baseline DIN 5034
 *     screening question.
 *   - No self-shadow from the same building's other wings (L-shaped
 *     buildings would need this). Goldbeck precast is almost always
 *     rectangular-plan, so this matters for <5 % of real projects.
 *   - No atmospheric extinction / cloud cover — DIN 5034 is a clear-
 *     sky geometric model.
 *
 * If the caller omits latitude / longitude (e.g. project has no plot
 * geocoded yet), the analyzer returns 0 issues so validation doesn't
 * emit bogus warnings.
 */

import type {
  FloorPlan,
  FloorPlanApartment,
  FloorPlanRoom,
  WindowPlacement,
  WallSegment,
  Point2D,
} from "@/types/api";

// ── Constants ─────────────────────────────────────────────────────

/** DIN 5034-1 reference day — 17 January. */
export const BESONNUNG_REF_MONTH = 1; // January
export const BESONNUNG_REF_DAY = 17;

/** Reference window in local solar time [h]. */
export const BESONNUNG_START_H = 9;
export const BESONNUNG_END_H = 15;

/** Sampling step [min]. */
export const BESONNUNG_STEP_MIN = 10;

/** Pass threshold per DIN 5034-1 §4.3 [h]. */
export const BESONNUNG_MIN_HOURS = 1.0;

/** Warn threshold below pass [h]. */
export const BESONNUNG_WARN_HOURS = 0.5;

/** Habitable rooms that count toward DIN 5034 — per §4.2, Wohnräume
 *  and Schlafräume must have a sunlit window; bathrooms / kitchens /
 *  halls are out of scope (different §s for daylight vs. sun). */
const HABITABLE_ROOM_TYPES = new Set(["living", "bedroom"]);

// ── Types ─────────────────────────────────────────────────────────

export interface WindowBesonnungResult {
  windowId: string;
  /** Apartment that owns the host room, if any. */
  apartmentId?: string;
  /** Room the window serves (best-effort: nearest room whose bbox
   *  contains the window position). */
  roomId?: string;
  /** Window outward-normal geographic azimuth, 0° = north, clockwise. */
  normalAzimuthDeg: number;
  /** Direct sun hours on Jan 17 between 09:00-15:00 [h]. */
  sunHours: number;
}

export interface ApartmentBesonnungResult {
  apartmentId: string;
  /** Best sun-hours across all habitable-room windows in the apt. */
  bestSunHours: number;
  /** Window id with the best sun access, if any. */
  bestWindowId?: string;
  status: "pass" | "warn" | "fail";
  reason: string;
}

export interface BesonnungAnalysis {
  windows: WindowBesonnungResult[];
  apartments: ApartmentBesonnungResult[];
  pass: number;
  warn: number;
  fail: number;
  /** True if the analyzer ran — false when lat/lng were missing. */
  evaluated: boolean;
}

// ── Solar geometry ────────────────────────────────────────────────

/** NOAA/NREL approximate solar position. Accurate to ±0.5° for
 *  mid-latitudes, which is well within DIN 5034 screening tolerance.
 *  Returns azimuth in degrees (0 = north, clockwise) and altitude
 *  above horizon in degrees.
 *
 *  Inputs:
 *    - latDeg, lngDeg: observer position (decimal degrees)
 *    - utcDate: sampling time in UTC
 */
export function sunPosition(
  latDeg: number,
  lngDeg: number,
  utcDate: Date,
): { azimuthDeg: number; altitudeDeg: number } {
  // Julian day (since J2000.0)
  const jd =
    utcDate.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0;

  // Mean solar longitude [deg]
  const L = (280.46 + 0.9856474 * jd) % 360;
  // Mean anomaly [deg]
  const g = ((357.528 + 0.9856003 * jd) % 360) * (Math.PI / 180);
  // Ecliptic longitude [rad]
  const lambda =
    ((L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360) *
    (Math.PI / 180);
  // Obliquity of ecliptic [rad]
  const epsilon = 23.439 * (Math.PI / 180);

  // Right ascension [rad], declination [rad]
  const alpha = Math.atan2(
    Math.cos(epsilon) * Math.sin(lambda),
    Math.cos(lambda),
  );
  const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambda));

  // GMST [deg]
  const gmst =
    (18.697374558 + 24.06570982441908 * jd) % 24;
  const lst = (gmst * 15 + lngDeg) * (Math.PI / 180);
  const H = lst - alpha; // hour angle [rad]

  const phi = latDeg * (Math.PI / 180);
  const sinAlt =
    Math.sin(phi) * Math.sin(delta) +
    Math.cos(phi) * Math.cos(delta) * Math.cos(H);
  const altitude = Math.asin(sinAlt);

  // Azimuth measured from north, clockwise (0 = N, 90 = E, 180 = S, 270 = W)
  const az = Math.atan2(
    -Math.sin(H),
    Math.tan(delta) * Math.cos(phi) - Math.sin(phi) * Math.cos(H),
  );
  const azDeg = ((az * 180) / Math.PI + 360) % 360;

  return {
    azimuthDeg: azDeg,
    altitudeDeg: (altitude * 180) / Math.PI,
  };
}

/** Angular difference between two azimuths [deg], in [0, 180]. */
function azimuthDelta(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

// ── Geometry helpers ──────────────────────────────────────────────

/** Outward normal of a wall, in plan-local coords. Returns unit vector
 *  (nx, ny) pointing away from the building centroid. Assumes the wall
 *  is an exterior wall — interior partitions produce a meaningless
 *  "outward" but we filter those out before calling this. */
function wallOutwardNormal(
  wall: WallSegment,
  planCentroid: Point2D,
): { nx: number; ny: number } {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { nx: 0, ny: 1 };
  // Two candidate normals, perpendicular to wall axis
  const n1 = { nx: -dy / len, ny: dx / len };
  const n2 = { nx: dy / len, ny: -dx / len };
  // Pick the one pointing AWAY from the plan centroid — that's outward.
  const midX = (wall.start.x + wall.end.x) / 2;
  const midY = (wall.start.y + wall.end.y) / 2;
  const toOutward = { x: midX - planCentroid.x, y: midY - planCentroid.y };
  const dot1 = n1.nx * toOutward.x + n1.ny * toOutward.y;
  const dot2 = n2.nx * toOutward.x + n2.ny * toOutward.y;
  return dot1 >= dot2 ? n1 : n2;
}

/** Plan-local normal → geographic azimuth (0° = north, CW).
 *  Convention: plan +x is east, plan +y is north when rotationDeg = 0.
 *  rotationDeg rotates the building CCW about +z (standard math). */
function planNormalToGeographicAzimuth(
  nx: number,
  ny: number,
  rotationDeg: number,
): number {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Apply CCW rotation
  const gx = nx * cos - ny * sin;
  const gy = nx * sin + ny * cos;
  // atan2(east, north) → compass bearing from north clockwise
  const azRad = Math.atan2(gx, gy);
  return ((azRad * 180) / Math.PI + 360) % 360;
}

function planCentroidFromBbox(plan: FloorPlan): Point2D {
  const g = plan.structural_grid;
  return { x: g.building_length_m / 2, y: g.building_depth_m / 2 };
}

/** Find the room whose bbox contains the window position (best-effort).
 *  Returns the room + its owning apt id. */
function findRoomAndAptForWindow(
  win: WindowPlacement,
  plan: FloorPlan,
): { room?: FloorPlanRoom; apartmentId?: string } {
  const INFLATE = 0.4;
  for (const room of plan.rooms) {
    if (!room.polygon || room.polygon.length < 3) continue;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const v of room.polygon) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
    if (
      win.position.x >= minX - INFLATE &&
      win.position.x <= maxX + INFLATE &&
      win.position.y >= minY - INFLATE &&
      win.position.y <= maxY + INFLATE
    ) {
      return { room, apartmentId: room.apartment_id };
    }
  }
  return {};
}

// ── Main analyzer ─────────────────────────────────────────────────

export interface BesonnungInput {
  plan: FloorPlan;
  /** Plot latitude (decimal degrees). Required; when missing, the
   *  analyzer returns `evaluated: false` and no issues. */
  latitude?: number;
  longitude?: number;
  /** Building rotation about +z, degrees CCW. Plan-local +y maps to
   *  geographic north when this is 0. Defaults to 0. */
  buildingRotationDeg?: number;
}

export function analyzeBesonnung(input: BesonnungInput): BesonnungAnalysis {
  const { plan, latitude, longitude } = input;
  const rotationDeg = input.buildingRotationDeg ?? 0;

  if (
    latitude === undefined ||
    longitude === undefined ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return {
      windows: [],
      apartments: [],
      pass: 0,
      warn: 0,
      fail: 0,
      evaluated: false,
    };
  }

  // 1. Pre-sample solar azimuths for Jan 17 of the current year, 09:00-
  //    15:00 local solar time at 10-min steps.
  //    We approximate "local solar time" by using the local civil time
  //    as UTC offset = longitude/15 h. DIN 5034 defines the reference
  //    window in MEZ (UTC+1) but for a lat/lng based observer this is
  //    the standard convention anyway.
  const year = new Date().getFullYear();
  const samples: { altitudeDeg: number; azimuthDeg: number }[] = [];
  const stepMs = BESONNUNG_STEP_MIN * 60 * 1000;
  // Civil time offset from UTC (Germany = +1h standard, no DST in January)
  const tzOffsetH = 1;
  const startUtcMs = Date.UTC(
    year,
    BESONNUNG_REF_MONTH - 1,
    BESONNUNG_REF_DAY,
    BESONNUNG_START_H - tzOffsetH,
    0,
    0,
  );
  const endUtcMs = Date.UTC(
    year,
    BESONNUNG_REF_MONTH - 1,
    BESONNUNG_REF_DAY,
    BESONNUNG_END_H - tzOffsetH,
    0,
    0,
  );
  for (let t = startUtcMs; t <= endUtcMs; t += stepMs) {
    samples.push(sunPosition(latitude, longitude, new Date(t)));
  }
  const hoursPerSample = BESONNUNG_STEP_MIN / 60;

  // 2. Window pass — compute geographic normal + sun hours.
  const planCentroid = planCentroidFromBbox(plan);
  const wallById = new Map<string, WallSegment>(
    (plan.walls ?? []).map((w) => [w.id, w]),
  );

  const windowResults: WindowBesonnungResult[] = [];
  const byApt = new Map<string, WindowBesonnungResult[]>();

  for (const win of plan.windows ?? []) {
    const wall = wallById.get(win.wall_id);
    if (!wall) continue;
    const normalLocal = wallOutwardNormal(wall, planCentroid);
    const normalAz = planNormalToGeographicAzimuth(
      normalLocal.nx,
      normalLocal.ny,
      rotationDeg,
    );
    // Sum sun-exposed samples.
    let sunHours = 0;
    for (const s of samples) {
      if (s.altitudeDeg <= 0) continue;
      const delta = azimuthDelta(s.azimuthDeg, normalAz);
      if (delta <= 90) sunHours += hoursPerSample;
    }

    const { room, apartmentId } = findRoomAndAptForWindow(win, plan);
    const result: WindowBesonnungResult = {
      windowId: win.id,
      apartmentId,
      roomId: room?.id,
      normalAzimuthDeg: normalAz,
      sunHours,
    };
    windowResults.push(result);

    // Aggregate per apt for the habitable rooms only.
    if (
      apartmentId &&
      room &&
      HABITABLE_ROOM_TYPES.has(room.room_type)
    ) {
      const arr = byApt.get(apartmentId) ?? [];
      arr.push(result);
      byApt.set(apartmentId, arr);
    }
  }

  // 3. Apartment verdicts — best habitable window per apt.
  const apartmentResults: ApartmentBesonnungResult[] = [];
  for (const apt of (plan.apartments ?? []) as FloorPlanApartment[]) {
    const winsForApt = byApt.get(apt.id) ?? [];
    let best: WindowBesonnungResult | undefined;
    for (const w of winsForApt) {
      if (!best || w.sunHours > best.sunHours) best = w;
    }
    const bestSunHours = best?.sunHours ?? 0;
    let status: ApartmentBesonnungResult["status"];
    let reason: string;
    if (winsForApt.length === 0) {
      status = "fail";
      reason = "Keine Fenster in Wohn-/Schlafräumen — DIN 5034 nicht prüfbar";
    } else if (bestSunHours >= BESONNUNG_MIN_HOURS) {
      status = "pass";
      reason = `Besonnung ${bestSunHours.toFixed(1)} h am 17.01. (≥ ${BESONNUNG_MIN_HOURS.toFixed(1)} h)`;
    } else if (bestSunHours >= BESONNUNG_WARN_HOURS) {
      status = "warn";
      reason = `Besonnung ${bestSunHours.toFixed(1)} h am 17.01. — unter DIN 5034-1 (1 h)`;
    } else {
      status = "fail";
      reason = `Besonnung ${bestSunHours.toFixed(1)} h am 17.01. — DIN 5034-1 Verletzung`;
    }
    apartmentResults.push({
      apartmentId: apt.id,
      bestSunHours,
      bestWindowId: best?.windowId,
      status,
      reason,
    });
  }

  const pass = apartmentResults.filter((a) => a.status === "pass").length;
  const warn = apartmentResults.filter((a) => a.status === "warn").length;
  const fail = apartmentResults.filter((a) => a.status === "fail").length;

  return {
    windows: windowResults,
    apartments: apartmentResults,
    pass,
    warn,
    fail,
    evaluated: true,
  };
}
