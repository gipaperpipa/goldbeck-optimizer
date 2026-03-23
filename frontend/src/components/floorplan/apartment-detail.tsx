"use client";

import type { FloorPlanApartment } from "@/types/api";

interface ApartmentDetailProps {
  apartment: FloorPlanApartment;
}

const APT_TYPE_LABELS: Record<string, string> = {
  "1_room": "1-Room Apartment",
  "2_room": "2-Room Apartment",
  "3_room": "3-Room Apartment",
  "4_room": "4-Room Apartment",
  "5_room": "5-Room Apartment",
};

const ROOM_TYPE_LABELS: Record<string, string> = {
  living: "Living Room",
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  hallway: "Hallway",
  storage: "Storage",
  balcony: "Balcony",
};

const BATH_TYPE_LABELS: Record<string, string> = {
  type_i: "Type I (Barrier-free, washer)",
  type_ii: "Type II (Barrier-free)",
  type_iii: "Type III (Standard)",
  type_iv: "Type IV (Barrier-free)",
};

export function ApartmentDetail({ apartment }: ApartmentDetailProps) {
  return (
    <div className="bg-white border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">
          {apartment.unit_number}
        </h4>
        <span className="text-xs bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">
          {APT_TYPE_LABELS[apartment.apartment_type] || apartment.apartment_type}
        </span>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-500">Total Area</span>
        <span className="font-medium">{apartment.total_area_sqm.toFixed(1)} m&sup2;</span>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-500">Side</span>
        <span className="font-medium capitalize">{apartment.side}</span>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-500">Bays</span>
        <span className="font-medium">
          {apartment.bay_indices.map((i) => i + 1).join(", ")}
        </span>
      </div>

      <div className="border-t pt-2">
        <p className="text-xs font-medium text-neutral-500 uppercase mb-2">Rooms</p>
        <div className="space-y-1">
          {apartment.rooms.map((room) => (
            <div key={room.id} className="flex items-center justify-between text-xs">
              <span className="text-neutral-600">
                {room.label || ROOM_TYPE_LABELS[room.room_type] || room.room_type}
              </span>
              <span className="text-neutral-500">{room.area_sqm.toFixed(1)} m&sup2;</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t pt-2">
        <p className="text-xs font-medium text-neutral-500 uppercase mb-1">Bathroom</p>
        <div className="text-xs text-neutral-600">
          <div className="flex items-center justify-between">
            <span>{BATH_TYPE_LABELS[apartment.bathroom.bathroom_type] || apartment.bathroom.bathroom_type}</span>
            <span>{apartment.bathroom.area_sqm.toFixed(1)} m&sup2;</span>
          </div>
          <div className="text-neutral-400 mt-0.5">
            {apartment.bathroom.width_m.toFixed(2)}m x {apartment.bathroom.depth_m.toFixed(2)}m
          </div>
        </div>
      </div>
    </div>
  );
}
