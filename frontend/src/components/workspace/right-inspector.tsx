"use client";

import type { FloorPlanApartment, FloorPlanRoom } from "@/types/api";

const DIN_MIN_AREA: Record<string, number> = {
  living: 14.0,
  bedroom: 8.0,
  kitchen: 4.0,
  bathroom: 2.5,
  hallway: 1.5,
  storage: 0.5,
  corridor: 1.5,
};

const ROOM_LABELS: Record<string, string> = {
  living: "Wohnen",
  bedroom: "Schlafen",
  kitchen: "Küche",
  bathroom: "Bad",
  hallway: "Flur",
  corridor: "Flur",
  storage: "Abstellraum",
  balcony: "Balkon",
  shaft: "Schacht",
  staircase: "Treppe",
  elevator: "Aufzug",
};

function aptTypeLabel(t: string): string {
  const m = /^(\d)_room$/.exec(t);
  return m ? `${m[1]} Zi` : t.replace("_", " ");
}

function isSouth(side: string): boolean {
  const s = side.toLowerCase();
  return s.includes("south") || s === "s" || s.includes("süd");
}

function RoomRow({ room }: { room: FloorPlanRoom }) {
  const min = DIN_MIN_AREA[room.room_type] ?? 0;
  const ratio = min > 0 ? room.area_sqm / min : 1;
  const label = room.label || ROOM_LABELS[room.room_type] || room.room_type;
  const minRef = Math.max(min * 1.8, room.area_sqm * 1.05);

  return (
    <div
      style={{
        padding: "10px 0",
        borderTop: "1px solid var(--ws-line)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 13, color: "var(--ws-ink)", fontWeight: 500 }}>
          {label}
        </span>
        <span
          className="ws-mono"
          style={{ fontSize: 12, color: "var(--ws-ink-mid)" }}
        >
          {room.area_sqm.toFixed(1)} m²
        </span>
      </div>
      <div
        style={{
          height: 3,
          background: "oklch(0.94 0.005 85)",
          borderRadius: 1.5,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {min > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: `${Math.min(100, (min / minRef) * 100)}%`,
              background: "oklch(0.8 0.005 85)",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${Math.min(100, (room.area_sqm / minRef) * 100)}%`,
            background: "var(--ws-accent)",
          }}
        />
      </div>
      <div
        className="ws-mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 3,
          fontSize: 10,
          color: "var(--ws-ink-dim)",
        }}
      >
        <span>{min > 0 ? `DIN min. ${min.toFixed(1)}` : "—"}</span>
        {min > 0 && (
          <span
            style={{
              color:
                ratio > 1.1 ? "var(--ws-ok-fg)" : "var(--ws-ink-dim)",
            }}
          >
            ×{ratio.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}

export function RightInspector({
  apartment,
  qualityScore,
  floorLabel,
}: {
  apartment: FloorPlanApartment | null;
  /** 0..1 if available; falls back to a stub when null. */
  qualityScore?: number | null;
  floorLabel: string;
}) {
  if (!apartment) {
    return (
      <aside
        style={{
          width: 320,
          flexShrink: 0,
          borderLeft: "1px solid var(--ws-line)",
          background: "var(--ws-bg)",
          display: "flex",
          flexDirection: "column",
          padding: 20,
        }}
      >
        <div
          className="ws-mono"
          style={{
            fontSize: 11,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Wohnung
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--ws-ink-dim)",
            lineHeight: 1.5,
          }}
        >
          Keine Wohnung gewählt. Klicken Sie auf einen Raum im Grundriss oder
          eine Wohnung in der linken Liste.
        </div>
      </aside>
    );
  }

  const south = isSouth(apartment.side);
  const orientationLabel = south ? "Südausrichtung" : "Nordausrichtung";
  const quality = qualityScore ?? 0.85;

  // Sort rooms in a sensible inspector order.
  const roomOrder = [
    "living",
    "kitchen",
    "bedroom",
    "bathroom",
    "hallway",
    "corridor",
    "storage",
    "balcony",
  ];
  const rooms = [...apartment.rooms].sort(
    (a, b) =>
      roomOrder.indexOf(a.room_type) - roomOrder.indexOf(b.room_type),
  );

  return (
    <aside
      className="ws-scrollable"
      style={{
        width: 320,
        flexShrink: 0,
        borderLeft: "1px solid var(--ws-line)",
        background: "var(--ws-bg)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "18px 20px 14px",
          borderBottom: "1px solid var(--ws-line)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div
            className="ws-mono"
            style={{
              fontSize: 11,
              color: "var(--ws-ink-mid)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Wohnung
          </div>
          <span
            className="ws-mono"
            style={{
              fontSize: 13,
              color: "oklch(0.35 0.12 220)",
              fontWeight: 500,
            }}
          >
            {apartment.unit_number || apartment.id.slice(0, 6)}
          </span>
        </div>
        <div
          className="ws-serif"
          style={{
            fontSize: 32,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            color: "var(--ws-ink)",
            marginBottom: 2,
          }}
        >
          {aptTypeLabel(apartment.apartment_type)}
        </div>
        <div style={{ fontSize: 12, color: "var(--ws-ink-dim)", marginBottom: 12 }}>
          {orientationLabel} · {floorLabel}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginTop: 14,
          }}
        >
          <div>
            <div
              className="ws-mono"
              style={{
                fontSize: 10,
                color: "var(--ws-ink-dim)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Wohnfläche
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 500,
                color: "var(--ws-ink)",
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
              }}
            >
              {apartment.total_area_sqm.toFixed(1)}
              <span
                className="ws-mono"
                style={{
                  fontSize: 12,
                  color: "var(--ws-ink-dim)",
                  marginLeft: 3,
                  letterSpacing: 0,
                }}
              >
                m²
              </span>
            </div>
          </div>
          <div>
            <div
              className="ws-mono"
              style={{
                fontSize: 10,
                color: "var(--ws-ink-dim)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Qualität
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 500,
                color: "var(--ws-ink)",
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
              }}
            >
              {quality.toFixed(2)}
              <span
                className="ws-mono"
                style={{
                  fontSize: 12,
                  color: "var(--ws-ink-dim)",
                  marginLeft: 3,
                  letterSpacing: 0,
                }}
              >
                /1.00
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Rooms */}
      <div className="ws-scrollable" style={{ flex: 1, overflow: "auto" }}>
        <div style={{ padding: "14px 20px 6px" }}>
          <div
            className="ws-mono"
            style={{
              fontSize: 11,
              color: "var(--ws-ink-mid)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            Räume · {rooms.length}
          </div>
        </div>
        <div style={{ padding: "0 20px" }}>
          {rooms.map((r) => (
            <RoomRow key={r.id} room={r} />
          ))}
        </div>

        {/* Criteria breakdown — placeholder until per-apt quality scores
             are exposed by the optimizer */}
        <div
          style={{
            padding: "20px 20px 18px",
            borderTop: "1px solid var(--ws-line)",
            marginTop: 14,
          }}
        >
          <div
            className="ws-mono"
            style={{
              fontSize: 11,
              color: "var(--ws-ink-mid)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontWeight: 500,
              marginBottom: 10,
            }}
          >
            Bewertung · 17 Kriterien
          </div>
          {[
            ["Belichtung", south ? 0.94 : 0.7],
            ["Akustik", 0.86],
            ["Proportionen", 0.89],
            ["Erschließung", 0.95],
            ["Flurbreite", 1.0],
            ["Südausrichtung", south ? 1.0 : 0.45],
          ].map(([k, v]) => {
            const value = v as number;
            return (
              <div
                key={k as string}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <span style={{ flex: 1, fontSize: 12, color: "var(--ws-ink-mid)" }}>
                  {k}
                </span>
                <div
                  style={{
                    width: 80,
                    height: 2,
                    background: "oklch(0.94 0.005 85)",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${value * 100}%`,
                      background:
                        value > 0.8
                          ? "oklch(0.55 0.09 150)"
                          : value > 0.6
                            ? "oklch(0.65 0.08 85)"
                            : "oklch(0.6 0.12 25)",
                    }}
                  />
                </div>
                <span
                  className="ws-mono"
                  style={{
                    width: 32,
                    textAlign: "right",
                    fontSize: 11,
                    color: "var(--ws-ink-mid)",
                  }}
                >
                  {value.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
