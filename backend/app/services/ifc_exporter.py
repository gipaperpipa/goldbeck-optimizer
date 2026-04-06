"""
IFC 2x3 exporter for building models.
Generates valid IFC-SPF (STEP Physical File) format that Revit can import.
Uses string-based generation — no ifcopenshell dependency required.

Standard IFC wall/slab convention:
  - Profile = plan-view cross-section in XY (length × thickness)
  - Extrude along Z (0,0,1) by element height
  - LocalPlacement rotates/positions the element in world space
"""

import uuid
import math
from datetime import datetime, timezone
from typing import Optional

from app.models.floorplan import (
    BuildingFloorPlans,
    FloorPlan,
    WallSegment,
    WindowPlacement,
    DoorPlacement,
    WallType,
)
from app.models.building import BuildingFootprint


def _guid() -> str:
    """Generate an IFC GlobalId (22-char base64 compressed UUID)."""
    u = uuid.uuid4().int
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
    result = []
    for _ in range(22):
        result.append(chars[u % 64])
        u //= 64
    return "".join(result)


class IfcWriter:
    """Builds an IFC 2x3 file from building data."""

    def __init__(self):
        self._lines: list[str] = []
        self._id = 0

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _add(self, entity: str) -> int:
        eid = self._next_id()
        self._lines.append(f"#{eid}={entity};")
        return eid

    def export_building(
        self,
        building: BuildingFootprint,
        floor_plans: BuildingFloorPlans,
    ) -> str:
        """Generate complete IFC file content as string."""
        self._lines = []
        self._id = 0

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

        # ── Header ──────────────────────────────────────────────
        header = f"""ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');
FILE_NAME('building_{building.id}.ifc','{now}',('Architect'),('a+a studio'),'IFC Exporter','BuildingOptimizer','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;"""

        # ── Core entities ───────────────────────────────────────
        person = self._add("IFCPERSON($,$,'Architect',$,$,$,$,$)")
        org = self._add("IFCORGANIZATION($,'a+a studio',$,$,$)")
        person_org = self._add(f"IFCPERSONANDORGANIZATION(#{person},#{org},$)")
        app = self._add(f"IFCAPPLICATION(#{org},'1.0','BuildingOptimizer','BuildingOptimizer')")
        owner = self._add(
            f"IFCOWNERHISTORY(#{person_org},#{app},$,.NOCHANGE.,$,"
            f"#{person_org},#{app},{int(datetime.now(timezone.utc).timestamp())})"
        )

        # Units
        len_unit = self._add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")
        area_unit = self._add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)")
        vol_unit = self._add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")
        angle_unit = self._add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")
        unit_assign = self._add(
            f"IFCUNITASSIGNMENT((#{len_unit},#{area_unit},#{vol_unit},#{angle_unit}))"
        )

        # Geometric context
        origin_3d = self._add("IFCCARTESIANPOINT((0.,0.,0.))")
        dir_z = self._add("IFCDIRECTION((0.,0.,1.))")
        dir_x = self._add("IFCDIRECTION((1.,0.,0.))")
        world_cs = self._add(f"IFCAXIS2PLACEMENT3D(#{origin_3d},#{dir_z},#{dir_x})")
        context = self._add(
            f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#{world_cs},$)"
        )
        body_ctx = self._add(
            f"IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#{context},$,.MODEL_VIEW.,$)"
        )

        # Project
        project = self._add(
            f"IFCPROJECT('{_guid()}',#{owner},'Building Project',$,$,$,$,(#{context}),#{unit_assign})"
        )

        # Site
        site_place = self._add(f"IFCLOCALPLACEMENT($,#{world_cs})")
        site = self._add(
            f"IFCSITE('{_guid()}',#{owner},'Site',$,$,#{site_place},$,$,.ELEMENT.,$,$,$,$,$)"
        )

        # Building
        bld_place = self._add(f"IFCLOCALPLACEMENT(#{site_place},#{world_cs})")
        ifc_building = self._add(
            f"IFCBUILDING('{_guid()}',#{owner},'{building.id}',$,$,#{bld_place},$,$,.ELEMENT.,$,$,$)"
        )

        # Spatial containment: Project > Site > Building
        self._add(f"IFCRELAGGREGATES('{_guid()}',#{owner},$,$,#{project},(#{site}))")
        self._add(f"IFCRELAGGREGATES('{_guid()}',#{owner},$,$,#{site},(#{ifc_building}))")

        story_height = floor_plans.story_height_m

        # ── Stories ─────────────────────────────────────────────
        storey_ids = []
        for fp in floor_plans.floor_plans:
            elevation = fp.floor_index * story_height
            pt = self._add(f"IFCCARTESIANPOINT((0.,0.,{elevation:.4f}))")
            ax = self._add(f"IFCAXIS2PLACEMENT3D(#{pt},#{dir_z},#{dir_x})")
            sp = self._add(f"IFCLOCALPLACEMENT(#{bld_place},#{ax})")
            storey = self._add(
                f"IFCBUILDINGSTOREY('{_guid()}',#{owner},'Floor {fp.floor_index}',$,$,"
                f"#{sp},$,$,.ELEMENT.,{elevation:.4f})"
            )
            storey_ids.append(storey)

            storey_elements = []

            # ── Walls ───────────────────────────────────────────
            # Build wall → IFC ID map for opening relationships
            wall_ifc_ids: dict[str, int] = {}
            for wall in fp.walls:
                ifc_wall_id = self._create_wall(wall, story_height, owner, body_ctx, sp)
                if ifc_wall_id:
                    storey_elements.append(ifc_wall_id)
                    wall_ifc_ids[wall.id] = ifc_wall_id

            # ── Windows (with IfcOpeningElement for void cutting) ──
            for win in fp.windows:
                win_wall = self._find_nearest_wall(win.position, fp.walls)
                win_id = self._create_window(win, win_wall, owner, body_ctx, sp)
                if win_id and win_wall:
                    storey_elements.append(win_id)
                    # Create opening element to cut wall void
                    host_wall_ifc = wall_ifc_ids.get(win_wall.id)
                    if host_wall_ifc:
                        self._create_opening(
                            win, win_wall, story_height,
                            host_wall_ifc, win_id,
                            owner, body_ctx, sp, is_window=True,
                        )

            # ── Doors (with IfcOpeningElement for void cutting) ───
            for door in fp.doors:
                door_wall = self._find_nearest_wall(door.position, fp.walls)
                door_id = self._create_door(door, door_wall, owner, body_ctx, sp)
                if door_id and door_wall:
                    storey_elements.append(door_id)
                    host_wall_ifc = wall_ifc_ids.get(door_wall.id)
                    if host_wall_ifc:
                        self._create_opening(
                            door, door_wall, story_height,
                            host_wall_ifc, door_id,
                            owner, body_ctx, sp, is_window=False,
                        )

            # ── Slab (uses per-floor grid for Staffelgeschoss) ──
            slab_w = getattr(fp.structural_grid, 'building_length_m', None) or floor_plans.building_width_m
            slab_d = getattr(fp.structural_grid, 'building_depth_m', None) or floor_plans.building_depth_m
            slab_id = self._create_slab(
                slab_w,
                slab_d,
                0.24,
                owner, body_ctx, sp,
            )
            if slab_id:
                storey_elements.append(slab_id)

            # Relate elements to storey
            if storey_elements:
                elems_str = ",".join(f"#{e}" for e in storey_elements)
                self._add(
                    f"IFCRELCONTAINEDINSPATIALSTRUCTURE('{_guid()}',#{owner},$,$,"
                    f"({elems_str}),#{storey})"
                )

        # Aggregate storeys under building
        if storey_ids:
            storeys_str = ",".join(f"#{s}" for s in storey_ids)
            self._add(
                f"IFCRELAGGREGATES('{_guid()}',#{owner},$,$,#{ifc_building},({storeys_str}))"
            )

        # ── Assemble file ───────────────────────────────────────
        data_section = "\n".join(self._lines)
        return f"{header}\n{data_section}\nENDSEC;\nEND-ISO-10303-21;\n"

    # ────────────────────────────────────────────────────────────
    # Element creation — all use plan-view profiles extruded along Z
    # ────────────────────────────────────────────────────────────

    def _create_wall(
        self, wall: WallSegment, height: float,
        owner: int, body_ctx: int, storey_place: int,
    ) -> Optional[int]:
        """Create IfcWallStandardCase.

        Profile: plan-view rectangle (length × thickness) in XY
        Extrude: along Z (0,0,1) by story_height
        Placement: at wall start, rotated to match wall direction
        """
        dx = wall.end.x - wall.start.x
        dy = wall.end.y - wall.start.y
        length = math.sqrt(dx * dx + dy * dy)
        if length < 0.01:
            return None

        thickness = wall.thickness_m

        # Plan-view profile: rectangle (length along X, thickness along Y)
        profile = self._make_rectangle_profile(length, thickness)

        # Extrude upward along Z by story height
        ext_dir = self._add("IFCDIRECTION((0.,0.,1.))")
        solid = self._add(
            f"IFCEXTRUDEDAREASOLID(#{profile},#{self._identity_placement_3d()},"
            f"#{ext_dir},{height:.4f})"
        )
        shape = self._add(
            f"IFCSHAPEREPRESENTATION(#{body_ctx},'Body','SweptSolid',(#{solid}))"
        )
        prod_shape = self._add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape}))")

        # Place wall at start point, local X along wall direction
        angle = math.atan2(dy, dx)
        pt = self._add(f"IFCCARTESIANPOINT(({wall.start.x:.4f},{wall.start.y:.4f},0.))")
        ax_x = self._add(
            f"IFCDIRECTION(({math.cos(angle):.6f},{math.sin(angle):.6f},0.))"
        )
        ax_z = self._add("IFCDIRECTION((0.,0.,1.))")
        ax = self._add(f"IFCAXIS2PLACEMENT3D(#{pt},#{ax_z},#{ax_x})")
        local_place = self._add(f"IFCLOCALPLACEMENT(#{storey_place},#{ax})")

        wall_type_name = (
            wall.wall_type.value if hasattr(wall.wall_type, "value")
            else str(wall.wall_type)
        )
        wall_id = self._add(
            f"IFCWALLSTANDARDCASE('{_guid()}',#{owner},'{wall_type_name} Wall',$,$,"
            f"#{local_place},#{prod_shape},$)"
        )
        return wall_id

    def _create_window(
        self, win: WindowPlacement, wall: Optional[WallSegment],
        owner: int, body_ctx: int, storey_place: int,
    ) -> Optional[int]:
        """Create IfcWindow.

        Profile: plan-view rectangle (width × glass_thickness) in XY
        Extrude: along Z by window height
        Placement: at sill height, centered on window position
        """
        if not wall:
            return None

        glass_thickness = 0.06  # 60mm frame+glass

        # Plan-view profile: (width × glass_thickness) in XY
        profile = self._make_rectangle_profile(win.width_m, glass_thickness)

        # Extrude upward by window height
        ext_dir = self._add("IFCDIRECTION((0.,0.,1.))")
        solid = self._add(
            f"IFCEXTRUDEDAREASOLID(#{profile},#{self._identity_placement_3d()},"
            f"#{ext_dir},{win.height_m:.4f})"
        )
        shape = self._add(
            f"IFCSHAPEREPRESENTATION(#{body_ctx},'Body','SweptSolid',(#{solid}))"
        )
        prod_shape = self._add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape}))")

        # Position: at window center along wall, offset half-width back,
        # at sill height above storey level
        wdx = wall.end.x - wall.start.x
        wdy = wall.end.y - wall.start.y
        wlen = math.sqrt(wdx * wdx + wdy * wdy)
        if wlen < 0.01:
            return None
        angle = math.atan2(wdy, wdx)

        # Window position is in building coordinates; place at sill height
        wx = win.position.x - (win.width_m / 2) * math.cos(angle)
        wy = win.position.y - (win.width_m / 2) * math.sin(angle)
        sill = win.sill_height_m

        pt = self._add(f"IFCCARTESIANPOINT(({wx:.4f},{wy:.4f},{sill:.4f}))")
        ax_x = self._add(
            f"IFCDIRECTION(({math.cos(angle):.6f},{math.sin(angle):.6f},0.))"
        )
        ax_z = self._add("IFCDIRECTION((0.,0.,1.))")
        ax = self._add(f"IFCAXIS2PLACEMENT3D(#{pt},#{ax_z},#{ax_x})")
        local_place = self._add(f"IFCLOCALPLACEMENT(#{storey_place},#{ax})")

        win_id = self._add(
            f"IFCWINDOW('{_guid()}',#{owner},'Window',$,$,#{local_place},#{prod_shape},$,"
            f"{win.height_m:.4f},{win.width_m:.4f})"
        )
        return win_id

    def _create_door(
        self, door: DoorPlacement, wall: Optional[WallSegment],
        owner: int, body_ctx: int, storey_place: int,
    ) -> Optional[int]:
        """Create IfcDoor.

        Profile: plan-view rectangle (width × door_thickness) in XY
        Extrude: along Z by door height
        Placement: at floor level, centered on door position
        """
        if not wall:
            return None

        door_thickness = 0.06

        # Plan-view profile
        profile = self._make_rectangle_profile(door.width_m, door_thickness)

        # Extrude upward by door height
        ext_dir = self._add("IFCDIRECTION((0.,0.,1.))")
        solid = self._add(
            f"IFCEXTRUDEDAREASOLID(#{profile},#{self._identity_placement_3d()},"
            f"#{ext_dir},{door.height_m:.4f})"
        )
        shape = self._add(
            f"IFCSHAPEREPRESENTATION(#{body_ctx},'Body','SweptSolid',(#{solid}))"
        )
        prod_shape = self._add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape}))")

        wdx = wall.end.x - wall.start.x
        wdy = wall.end.y - wall.start.y
        wlen = math.sqrt(wdx * wdx + wdy * wdy)
        if wlen < 0.01:
            return None
        angle = math.atan2(wdy, wdx)

        wx = door.position.x - (door.width_m / 2) * math.cos(angle)
        wy = door.position.y - (door.width_m / 2) * math.sin(angle)

        pt = self._add(f"IFCCARTESIANPOINT(({wx:.4f},{wy:.4f},0.))")
        ax_x = self._add(
            f"IFCDIRECTION(({math.cos(angle):.6f},{math.sin(angle):.6f},0.))"
        )
        ax_z = self._add("IFCDIRECTION((0.,0.,1.))")
        ax = self._add(f"IFCAXIS2PLACEMENT3D(#{pt},#{ax_z},#{ax_x})")
        local_place = self._add(f"IFCLOCALPLACEMENT(#{storey_place},#{ax})")

        door_label = "Entrance Door" if door.is_entrance else "Interior Door"
        door_id = self._add(
            f"IFCDOOR('{_guid()}',#{owner},'{door_label}',$,$,#{local_place},"
            f"#{prod_shape},$,{door.height_m:.4f},{door.width_m:.4f})"
        )
        return door_id

    def _create_slab(
        self, width: float, depth: float, thickness: float,
        owner: int, body_ctx: int, storey_place: int,
    ) -> int:
        """Create IfcSlab.

        Profile: plan-view rectangle (width × depth) in XY
        Extrude: along Z by slab thickness
        Placement: at -thickness (below storey level)
        """
        profile = self._make_rectangle_profile(width, depth)

        ext_dir = self._add("IFCDIRECTION((0.,0.,1.))")
        solid = self._add(
            f"IFCEXTRUDEDAREASOLID(#{profile},#{self._identity_placement_3d()},"
            f"#{ext_dir},{thickness:.4f})"
        )
        shape = self._add(
            f"IFCSHAPEREPRESENTATION(#{body_ctx},'Body','SweptSolid',(#{solid}))"
        )
        prod_shape = self._add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape}))")

        # Place slab below storey level
        dir_z = self._add("IFCDIRECTION((0.,0.,1.))")
        dir_x = self._add("IFCDIRECTION((1.,0.,0.))")
        pt_origin = self._add(f"IFCCARTESIANPOINT((0.,0.,{-thickness:.4f}))")
        ax = self._add(f"IFCAXIS2PLACEMENT3D(#{pt_origin},#{dir_z},#{dir_x})")
        local_place = self._add(f"IFCLOCALPLACEMENT(#{storey_place},#{ax})")

        slab_id = self._add(
            f"IFCSLAB('{_guid()}',#{owner},'Floor Slab',$,$,#{local_place},"
            f"#{prod_shape},$,.FLOOR.)"
        )
        return slab_id

    # ── Opening elements (void cutting) ────────────────────────

    def _create_opening(
        self, element, wall: WallSegment, story_height: float,
        host_wall_ifc: int, filling_ifc: int,
        owner: int, body_ctx: int, storey_place: int,
        is_window: bool = True,
    ) -> Optional[int]:
        """Create IfcOpeningElement that cuts a void in the host wall.

        The opening is placed at the element position along the wall,
        with a rectangular profile slightly larger than the element
        to ensure clean boolean subtraction.
        """
        dx = wall.end.x - wall.start.x
        dy = wall.end.y - wall.start.y
        wlen = math.sqrt(dx * dx + dy * dy)
        if wlen < 0.01:
            return None

        angle = math.atan2(dy, dx)

        # Opening dimensions (slightly larger than element for clean cut)
        elem_width = element.width_m + 0.02
        elem_height = element.height_m + 0.02 if is_window else element.height_m + 0.02
        opening_depth = wall.thickness_m + 0.04  # Extend through wall

        sill = element.sill_height_m if is_window else 0.0

        # Opening profile in XY: width × depth
        profile = self._make_rectangle_profile(elem_width, opening_depth)

        # Extrude along Z by opening height
        ext_dir = self._add("IFCDIRECTION((0.,0.,1.))")
        solid = self._add(
            f"IFCEXTRUDEDAREASOLID(#{profile},#{self._identity_placement_3d()},"
            f"#{ext_dir},{elem_height:.4f})"
        )
        shape = self._add(
            f"IFCSHAPEREPRESENTATION(#{body_ctx},'Body','SweptSolid',(#{solid}))"
        )
        prod_shape = self._add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape}))")

        # Position: at element center along wall, offset half-width,
        # perpendicular offset to center opening through wall
        ox = element.position.x - (elem_width / 2) * math.cos(angle)
        oy = element.position.y - (elem_width / 2) * math.sin(angle)
        # Offset perpendicular by half-depth so opening penetrates full wall
        perp_x = -math.sin(angle) * (opening_depth / 2)
        perp_y = math.cos(angle) * (opening_depth / 2)
        ox -= perp_x
        oy -= perp_y

        pt = self._add(f"IFCCARTESIANPOINT(({ox:.4f},{oy:.4f},{sill:.4f}))")
        ax_x = self._add(
            f"IFCDIRECTION(({math.cos(angle):.6f},{math.sin(angle):.6f},0.))"
        )
        ax_z = self._add("IFCDIRECTION((0.,0.,1.))")
        ax = self._add(f"IFCAXIS2PLACEMENT3D(#{pt},#{ax_z},#{ax_x})")
        local_place = self._add(f"IFCLOCALPLACEMENT(#{storey_place},#{ax})")

        opening_id = self._add(
            f"IFCOPENINGELEMENT('{_guid()}',#{owner},'Opening',$,$,"
            f"#{local_place},#{prod_shape},$)"
        )

        # Relationship: opening voids the host wall
        self._add(
            f"IFCRELVOIDSELEMENT('{_guid()}',#{owner},$,$,"
            f"#{host_wall_ifc},#{opening_id})"
        )

        # Relationship: element fills the opening
        self._add(
            f"IFCRELFILLSELEMENT('{_guid()}',#{owner},$,$,"
            f"#{opening_id},#{filling_ifc})"
        )

        return opening_id

    # ── Helpers ─────────────────────────────────────────────────

    @staticmethod
    def _find_nearest_wall(position, walls: list) -> Optional[WallSegment]:
        """Find the closest wall to a door/window position.

        Uses perpendicular distance from the point to each wall segment.
        This replaces symbolic wall_id matching which was unreliable.
        """
        best_wall = None
        best_dist = float("inf")

        px, py = position.x, position.y
        for wall in walls:
            # Wall as line segment
            sx, sy = wall.start.x, wall.start.y
            ex, ey = wall.end.x, wall.end.y
            dx, dy = ex - sx, ey - sy
            seg_len_sq = dx * dx + dy * dy
            if seg_len_sq < 0.001:
                continue

            # Project point onto wall line segment
            t = max(0, min(1, ((px - sx) * dx + (py - sy) * dy) / seg_len_sq))
            proj_x = sx + t * dx
            proj_y = sy + t * dy
            dist = math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2)

            if dist < best_dist:
                best_dist = dist
                best_wall = wall

        return best_wall

    def _make_rectangle_profile(self, length: float, width: float) -> int:
        """Create a rectangular IfcArbitraryClosedProfileDef in XY plane.

        length: extent along X
        width: extent along Y
        """
        pt1 = self._add("IFCCARTESIANPOINT((0.,0.))")
        pt2 = self._add(f"IFCCARTESIANPOINT(({length:.4f},0.))")
        pt3 = self._add(f"IFCCARTESIANPOINT(({length:.4f},{width:.4f}))")
        pt4 = self._add(f"IFCCARTESIANPOINT((0.,{width:.4f}))")
        polyline = self._add(f"IFCPOLYLINE((#{pt1},#{pt2},#{pt3},#{pt4},#{pt1}))")
        return self._add(f"IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#{polyline})")

    def _identity_placement_3d(self) -> int:
        """Return an IFCAXIS2PLACEMENT3D at origin (required by IFCEXTRUDEDAREASOLID)."""
        pt = self._add("IFCCARTESIANPOINT((0.,0.,0.))")
        dz = self._add("IFCDIRECTION((0.,0.,1.))")
        dx = self._add("IFCDIRECTION((1.,0.,0.))")
        return self._add(f"IFCAXIS2PLACEMENT3D(#{pt},#{dz},#{dx})")
