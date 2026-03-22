using System;
using System.Collections.Generic;
using System.Linq;
using Rhino.Geometry;
using GoldbeckSync.Protocol;

namespace GoldbeckSync.Geometry
{
    /// <summary>
    /// Builds native Rhino geometry from optimizer floor plan data.
    /// Creates proper BRep walls with boolean-subtracted openings,
    /// slabs, bathroom pods, room zones, and furniture zones.
    /// </summary>
    public class GoldbeckGeometryBuilder
    {
        // --- Output collections (populated by Build()) ---
        public List<Brep> Walls { get; private set; } = new List<Brep>();
        public List<Brep> Slabs { get; private set; } = new List<Brep>();
        public List<Brep> WindowGlass { get; private set; } = new List<Brep>();
        public List<Brep> DoorPanels { get; private set; } = new List<Brep>();
        public List<Brep> BathroomPods { get; private set; } = new List<Brep>();
        public List<Curve> RoomOutlines { get; private set; } = new List<Curve>();
        public List<Curve> ApartmentOutlines { get; private set; } = new List<Curve>();
        public List<Curve> GridLines { get; private set; } = new List<Curve>();
        public List<Brep> BalconySlabs { get; private set; } = new List<Brep>();
        public List<Brep> FurnitureZones { get; private set; } = new List<Brep>();
        public List<TextDot> Labels { get; private set; } = new List<TextDot>();

        // Metadata
        public List<string> WallIds { get; private set; } = new List<string>();
        public List<string> RoomLabels { get; private set; } = new List<string>();
        public List<string> ApartmentLabels { get; private set; } = new List<string>();

        private double _tolerance = 0.001;

        /// <summary>
        /// Build all geometry from the optimizer's building data.
        /// </summary>
        public void Build(BuildingData building)
        {
            ClearAll();
            if (building?.FloorPlans == null) return;

            var storyHeight = building.StoryHeight;

            foreach (var fp in building.FloorPlans)
            {
                double zBase = fp.FloorIndex * storyHeight;
                BuildFloorPlan(fp, storyHeight, zBase);
            }

            // Roof slab
            double roofZ = building.NumStories * storyHeight;
            BuildSlab(building.BuildingWidth, building.BuildingDepth, roofZ, 0.24);

            // Structural grid lines (full height)
            BuildGridLines(building.StructuralGrid, building.NumStories * storyHeight);
        }

        private void BuildFloorPlan(FloorPlanData fp, double storyHeight, double zBase)
        {
            // --- 1. Walls with openings ---
            if (fp.Walls != null)
            {
                foreach (var wall in fp.Walls)
                {
                    // Collect doors and windows that belong to this wall (nearest-wall matching)
                    var wallDoors = FindDoorsOnWall(wall, fp.Doors);
                    var wallWindows = FindWindowsOnWall(wall, fp.Windows);
                    var wallBrep = BuildWall(wall, storyHeight, zBase, wallDoors, wallWindows);
                    if (wallBrep != null)
                    {
                        Walls.Add(wallBrep);
                        WallIds.Add(wall.Id);
                    }
                }
            }

            // --- 2. Floor slab ---
            var grid = fp.Grid;
            BuildSlab(grid.BuildingLength, grid.BuildingDepth, zBase, 0.24);

            // --- 3. Rooms (outlines + labels + hatching) ---
            if (fp.Rooms != null)
            {
                foreach (var room in fp.Rooms)
                    BuildRoom(room, zBase);
            }

            // --- 4. Apartments ---
            if (fp.Apartments != null)
            {
                foreach (var apt in fp.Apartments)
                {
                    BuildApartment(apt, zBase, storyHeight);
                }
            }

            // --- 5. Window glass panes ---
            if (fp.Windows != null)
            {
                foreach (var win in fp.Windows)
                    BuildWindowGlass(win, zBase);
            }

            // --- 6. Door panels ---
            if (fp.Doors != null)
            {
                foreach (var door in fp.Doors)
                    BuildDoorPanel(door, zBase);
            }
        }

        // ────────────────────────────────────────────────────────────
        //  Wall with boolean-subtracted openings
        // ────────────────────────────────────────────────────────────

        private Brep BuildWall(WallData wall, double height, double zBase,
            List<DoorData> doors, List<WindowData> windows)
        {
            double dx = wall.End.X - wall.Start.X;
            double dy = wall.End.Y - wall.Start.Y;
            double wallLength = Math.Sqrt(dx * dx + dy * dy);
            if (wallLength < 0.01) return null;

            double thickness = wall.Thickness;

            // Wall direction and perpendicular
            var dir = new Vector3d(dx, dy, 0);
            dir.Unitize();
            var perp = new Vector3d(-dir.Y, dir.X, 0);

            // Build wall solid as box
            var corner0 = new Point3d(wall.Start.X, wall.Start.Y, zBase) - perp * (thickness / 2.0);
            var corner1 = corner0 + dir * wallLength;
            var corner2 = corner1 + perp * thickness;
            var corner3 = corner0 + perp * thickness;

            var pts = new Point3d[]
            {
                corner0, corner1, corner2, corner3, corner0
            };
            var baseCurve = new Polyline(pts).ToPolylineCurve();
            var wallExtrusion = Extrusion.Create(baseCurve, height, true);
            if (wallExtrusion == null) return null;
            var wallBrep = wallExtrusion.ToBrep();

            // Boolean subtract door openings
            foreach (var door in doors)
            {
                var openingBrep = CreateOpeningBox(
                    new Point3d(door.Position.X, door.Position.Y, zBase),
                    dir, perp, door.Width, door.Height, thickness + 0.04
                );
                if (openingBrep != null)
                {
                    var result = Brep.CreateBooleanDifference(wallBrep, openingBrep, _tolerance);
                    if (result != null && result.Length > 0)
                        wallBrep = result[0];
                }
            }

            // Boolean subtract window openings
            foreach (var win in windows)
            {
                var openingBrep = CreateOpeningBox(
                    new Point3d(win.Position.X, win.Position.Y, zBase + win.SillHeight),
                    dir, perp, win.Width, win.Height, thickness + 0.04
                );
                if (openingBrep != null)
                {
                    var result = Brep.CreateBooleanDifference(wallBrep, openingBrep, _tolerance);
                    if (result != null && result.Length > 0)
                        wallBrep = result[0];
                }
            }

            return wallBrep;
        }

        private Brep CreateOpeningBox(Point3d center, Vector3d wallDir, Vector3d wallPerp,
            double width, double height, double depth)
        {
            var halfW = wallDir * (width / 2.0);
            var halfD = wallPerp * (depth / 2.0);

            var pts = new Point3d[]
            {
                center - halfW - halfD,
                center + halfW - halfD,
                center + halfW + halfD,
                center - halfW + halfD,
                center - halfW - halfD,
            };
            var baseCurve = new Polyline(pts).ToPolylineCurve();
            var extrusion = Extrusion.Create(baseCurve, height, true);
            return extrusion?.ToBrep();
        }

        // ────────────────────────────────────────────────────────────
        //  Slab
        // ────────────────────────────────────────────────────────────

        private void BuildSlab(double length, double depth, double z, double thickness)
        {
            var pts = new Point3d[]
            {
                new Point3d(0, 0, z - thickness),
                new Point3d(length, 0, z - thickness),
                new Point3d(length, depth, z - thickness),
                new Point3d(0, depth, z - thickness),
                new Point3d(0, 0, z - thickness),
            };
            var baseCurve = new Polyline(pts).ToPolylineCurve();
            var extrusion = Extrusion.Create(baseCurve, thickness, true);
            if (extrusion != null)
                Slabs.Add(extrusion.ToBrep());
        }

        // ────────────────────────────────────────────────────────────
        //  Room outlines and labels
        // ────────────────────────────────────────────────────────────

        private void BuildRoom(RoomData room, double zBase)
        {
            if (room.Polygon == null || room.Polygon.Length < 3) return;

            var pts = room.Polygon.Select(p => new Point3d(p.X, p.Y, zBase + 0.01)).ToList();
            pts.Add(pts[0]); // Close polyline
            var outline = new Polyline(pts).ToPolylineCurve();
            RoomOutlines.Add(outline);
            RoomLabels.Add(room.Label ?? room.RoomType);

            // Label at centroid
            double cx = room.Polygon.Average(p => p.X);
            double cy = room.Polygon.Average(p => p.Y);
            Labels.Add(new TextDot($"{room.Label}\n{room.Area:F1}m²", new Point3d(cx, cy, zBase + 0.02)));
        }

        // ────────────────────────────────────────────────────────────
        //  Apartment outlines, bathroom pods, furniture zones
        // ────────────────────────────────────────────────────────────

        private void BuildApartment(ApartmentData apt, double zBase, double storyHeight)
        {
            // Apartment outline (convex hull of all rooms)
            var allPts = new List<Point3d>();
            if (apt.Rooms != null)
            {
                foreach (var room in apt.Rooms)
                {
                    if (room.Polygon != null)
                        allPts.AddRange(room.Polygon.Select(p => new Point3d(p.X, p.Y, zBase + 0.02)));

                    // Build room outlines for each apartment room
                    BuildRoom(room, zBase);

                    // Balcony slabs
                    if (room.RoomType == "balcony" && room.Polygon != null && room.Polygon.Length >= 4)
                    {
                        BuildBalconySlab(room, zBase);
                    }

                    // Furniture zones for living rooms and bedrooms
                    if (room.RoomType == "living" || room.RoomType == "bedroom")
                    {
                        BuildFurnitureZone(room, zBase);
                    }
                }
            }

            if (allPts.Count >= 3)
            {
                // Simple bounding polyline (convex hull would be better)
                var minX = allPts.Min(p => p.X);
                var maxX = allPts.Max(p => p.X);
                var minY = allPts.Min(p => p.Y);
                var maxY = allPts.Max(p => p.Y);

                var outline = new Polyline(new[]
                {
                    new Point3d(minX, minY, zBase + 0.03),
                    new Point3d(maxX, minY, zBase + 0.03),
                    new Point3d(maxX, maxY, zBase + 0.03),
                    new Point3d(minX, maxY, zBase + 0.03),
                    new Point3d(minX, minY, zBase + 0.03),
                }).ToPolylineCurve();
                ApartmentOutlines.Add(outline);
                ApartmentLabels.Add(apt.UnitNumber ?? apt.Id);

                Labels.Add(new TextDot(
                    $"{apt.UnitNumber} ({apt.ApartmentType})\n{apt.TotalArea:F1}m²",
                    new Point3d((minX + maxX) / 2, (minY + maxY) / 2, zBase + storyHeight * 0.5)
                ));
            }

            // Bathroom pod (3D extruded box)
            if (apt.Bathroom != null)
            {
                BuildBathroomPod(apt.Bathroom, zBase, storyHeight);
            }
        }

        private void BuildBathroomPod(BathroomData bath, double zBase, double storyHeight)
        {
            double podHeight = storyHeight * 0.9; // Pods don't go full height
            var pts = new Point3d[]
            {
                new Point3d(bath.Position.X, bath.Position.Y, zBase),
                new Point3d(bath.Position.X + bath.Width, bath.Position.Y, zBase),
                new Point3d(bath.Position.X + bath.Width, bath.Position.Y + bath.Depth, zBase),
                new Point3d(bath.Position.X, bath.Position.Y + bath.Depth, zBase),
                new Point3d(bath.Position.X, bath.Position.Y, zBase),
            };
            var baseCurve = new Polyline(pts).ToPolylineCurve();
            var extrusion = Extrusion.Create(baseCurve, podHeight, true);
            if (extrusion != null)
                BathroomPods.Add(extrusion.ToBrep());

            Labels.Add(new TextDot(
                $"Bath {bath.BathroomType}",
                new Point3d(bath.Position.X + bath.Width / 2, bath.Position.Y + bath.Depth / 2, zBase + 1.0)
            ));
        }

        private void BuildBalconySlab(RoomData room, double zBase)
        {
            var pts = room.Polygon.Select(p => new Point3d(p.X, p.Y, zBase)).ToList();
            pts.Add(pts[0]);
            var baseCurve = new Polyline(pts).ToPolylineCurve();
            var extrusion = Extrusion.Create(baseCurve, 0.20, true); // 20cm balcony slab
            if (extrusion != null)
                BalconySlabs.Add(extrusion.ToBrep());
        }

        private void BuildFurnitureZone(RoomData room, double zBase)
        {
            // Create a low box (10cm) as furniture placement zone indicator
            if (room.Polygon == null || room.Polygon.Length < 4) return;

            double minX = room.Polygon.Min(p => p.X) + 0.3;
            double maxX = room.Polygon.Max(p => p.X) - 0.3;
            double minY = room.Polygon.Min(p => p.Y) + 0.3;
            double maxY = room.Polygon.Max(p => p.Y) - 0.3;

            if (maxX <= minX || maxY <= minY) return;

            var pts = new Point3d[]
            {
                new Point3d(minX, minY, zBase + 0.01),
                new Point3d(maxX, minY, zBase + 0.01),
                new Point3d(maxX, maxY, zBase + 0.01),
                new Point3d(minX, maxY, zBase + 0.01),
                new Point3d(minX, minY, zBase + 0.01),
            };
            var baseCurve = new Polyline(pts).ToPolylineCurve();
            var extrusion = Extrusion.Create(baseCurve, 0.10, true);
            if (extrusion != null)
                FurnitureZones.Add(extrusion.ToBrep());
        }

        // ────────────────────────────────────────────────────────────
        //  Window glass panes and door panels
        // ────────────────────────────────────────────────────────────

        private void BuildWindowGlass(WindowData win, double zBase)
        {
            // Flat glass pane at window position
            double halfW = win.Width / 2.0 - 0.03;
            double halfH = win.Height / 2.0 - 0.03;
            double z = zBase + win.SillHeight + win.Height / 2.0;

            var plane = new Plane(new Point3d(win.Position.X, win.Position.Y, z), Vector3d.ZAxis);
            var rect = new Rectangle3d(plane, new Interval(-halfW, halfW), new Interval(-halfH, halfH));
            var surface = Brep.CreatePlanarBreps(rect.ToNurbsCurve(), _tolerance);
            if (surface != null && surface.Length > 0)
                WindowGlass.Add(surface[0]);
        }

        private void BuildDoorPanel(DoorData door, double zBase)
        {
            double halfW = door.Width / 2.0 - 0.02;
            double halfH = door.Height / 2.0 - 0.01;
            double z = zBase + door.Height / 2.0;

            var plane = new Plane(new Point3d(door.Position.X, door.Position.Y, z), Vector3d.ZAxis);
            var rect = new Rectangle3d(plane, new Interval(-halfW, halfW), new Interval(-halfH, halfH));
            var surface = Brep.CreatePlanarBreps(rect.ToNurbsCurve(), _tolerance);
            if (surface != null && surface.Length > 0)
                DoorPanels.Add(surface[0]);
        }

        // ────────────────────────────────────────────────────────────
        //  Structural grid lines
        // ────────────────────────────────────────────────────────────

        private void BuildGridLines(GridData grid, double totalHeight)
        {
            if (grid?.AxisPositionsX == null) return;

            // X-axis grid lines (along building length)
            foreach (var x in grid.AxisPositionsX)
            {
                GridLines.Add(new LineCurve(
                    new Point3d(x, -1, 0),
                    new Point3d(x, grid.BuildingDepth + 1, 0)
                ));
            }

            // Y-axis grid lines
            GridLines.Add(new LineCurve(new Point3d(-1, 0, 0), new Point3d(grid.BuildingLength + 1, 0, 0)));
            GridLines.Add(new LineCurve(new Point3d(-1, grid.BuildingDepth, 0), new Point3d(grid.BuildingLength + 1, grid.BuildingDepth, 0)));

            // Corridor lines
            if (grid.CorridorWidth > 0)
            {
                double cy = grid.CorridorYStart;
                GridLines.Add(new LineCurve(new Point3d(0, cy, 0), new Point3d(grid.BuildingLength, cy, 0)));
                GridLines.Add(new LineCurve(new Point3d(0, cy + grid.CorridorWidth, 0), new Point3d(grid.BuildingLength, cy + grid.CorridorWidth, 0)));
            }
        }

        // ────────────────────────────────────────────────────────────
        //  Nearest-wall matching (same algorithm as Python backend)
        // ────────────────────────────────────────────────────────────

        private List<DoorData> FindDoorsOnWall(WallData wall, DoorData[] allDoors)
        {
            if (allDoors == null) return new List<DoorData>();
            return allDoors.Where(d => IsOnWall(d.Position, wall)).ToList();
        }

        private List<WindowData> FindWindowsOnWall(WallData wall, WindowData[] allWindows)
        {
            if (allWindows == null) return new List<WindowData>();
            return allWindows.Where(w => IsOnWall(w.Position, wall)).ToList();
        }

        private bool IsOnWall(Point2D pos, WallData wall)
        {
            double sx = wall.Start.X, sy = wall.Start.Y;
            double ex = wall.End.X, ey = wall.End.Y;
            double dx = ex - sx, dy = ey - sy;
            double lenSq = dx * dx + dy * dy;
            if (lenSq < 0.001) return false;

            double t = Math.Max(0, Math.Min(1, ((pos.X - sx) * dx + (pos.Y - sy) * dy) / lenSq));
            double projX = sx + t * dx, projY = sy + t * dy;
            double dist = Math.Sqrt((pos.X - projX) * (pos.X - projX) + (pos.Y - projY) * (pos.Y - projY));

            // Within wall thickness + small tolerance
            return dist < wall.Thickness + 0.05;
        }

        private void ClearAll()
        {
            Walls.Clear(); WallIds.Clear();
            Slabs.Clear();
            WindowGlass.Clear();
            DoorPanels.Clear();
            BathroomPods.Clear();
            RoomOutlines.Clear(); RoomLabels.Clear();
            ApartmentOutlines.Clear(); ApartmentLabels.Clear();
            GridLines.Clear();
            BalconySlabs.Clear();
            FurnitureZones.Clear();
            Labels.Clear();
        }
    }
}
