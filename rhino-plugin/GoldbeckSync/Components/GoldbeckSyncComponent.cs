using System;
using System.Drawing;
using Grasshopper.Kernel;
using Rhino.Geometry;
using GoldbeckSync.Geometry;
using GoldbeckSync.Protocol;

namespace GoldbeckSync.Components
{
    /// <summary>
    /// Main Grasshopper component: connects to the optimizer via WebSocket
    /// and outputs live Rhino geometry for walls, slabs, openings, rooms,
    /// bathrooms, balconies, furniture zones, and structural grid.
    ///
    /// Inputs:
    ///   - ServerUrl: WebSocket URL (default ws://localhost:8000/ws/sync)
    ///   - Connect: boolean toggle to connect/disconnect
    ///   - VariantIndex: which optimizer variant to display (0 = best)
    ///
    /// Outputs:
    ///   - Walls: BRep walls with boolean-subtracted openings
    ///   - Slabs: BRep floor slabs
    ///   - Windows: BRep glass panes
    ///   - Doors: BRep door panels
    ///   - Bathrooms: BRep prefab bathroom pods
    ///   - Balconies: BRep balcony slabs
    ///   - RoomOutlines: Polyline room boundaries
    ///   - ApartmentOutlines: Polyline apartment boundaries
    ///   - GridLines: Structural grid lines
    ///   - FurnitureZones: BRep furniture placement zones
    ///   - Labels: TextDot labels for rooms and apartments
    ///   - Status: Connection/progress status text
    /// </summary>
    public class GoldbeckSyncComponent : GH_Component
    {
        private SyncClient _client;
        private GoldbeckGeometryBuilder _builder;
        private BuildingData _latestData;
        private string _status = "Disconnected";
        private bool _dataChanged;
        private readonly object _lock = new object();

        public GoldbeckSyncComponent()
            : base(
                "Goldbeck Live Sync",
                "GBSync",
                "Connects to the Goldbeck floor plan optimizer and builds live Rhino geometry via WebSocket.",
                "Goldbeck",
                "Sync")
        {
            _builder = new GoldbeckGeometryBuilder();
        }

        public override Guid ComponentGuid => new Guid("b2c3d4e5-f6a7-8901-bcde-f12345678901");

        protected override Bitmap Icon => null; // TODO: Add Goldbeck/a+a icon

        protected override void RegisterInputParams(GH_InputParamManager pManager)
        {
            pManager.AddTextParameter("ServerUrl", "URL",
                "WebSocket server URL", GH_ParamAccess.item, "ws://localhost:8000/ws/sync");
            pManager.AddBooleanParameter("Connect", "C",
                "Toggle to connect/disconnect", GH_ParamAccess.item, false);
            pManager.AddIntegerParameter("VariantIndex", "V",
                "Which optimization variant to display (0 = best)", GH_ParamAccess.item, 0);
        }

        protected override void RegisterOutputParams(GH_OutputParamManager pManager)
        {
            pManager.AddBrepParameter("Walls", "W", "BRep walls with openings", GH_ParamAccess.list);
            pManager.AddBrepParameter("Slabs", "S", "Floor slabs", GH_ParamAccess.list);
            pManager.AddBrepParameter("Windows", "Win", "Window glass panes", GH_ParamAccess.list);
            pManager.AddBrepParameter("Doors", "D", "Door panels", GH_ParamAccess.list);
            pManager.AddBrepParameter("Bathrooms", "Bath", "Prefab bathroom pods", GH_ParamAccess.list);
            pManager.AddBrepParameter("Balconies", "Bal", "Balcony slabs", GH_ParamAccess.list);
            pManager.AddCurveParameter("RoomOutlines", "RO", "Room boundary curves", GH_ParamAccess.list);
            pManager.AddCurveParameter("ApartmentOutlines", "AO", "Apartment boundary curves", GH_ParamAccess.list);
            pManager.AddCurveParameter("GridLines", "GL", "Structural grid lines", GH_ParamAccess.list);
            pManager.AddBrepParameter("FurnitureZones", "FZ", "Furniture placement zones", GH_ParamAccess.list);
            pManager.AddGenericParameter("Labels", "L", "TextDot labels", GH_ParamAccess.list);
            pManager.AddTextParameter("Status", "St", "Connection status", GH_ParamAccess.item);
        }

        protected override void SolveInstance(IGH_DataAccess DA)
        {
            string url = "ws://localhost:8000/ws/sync";
            bool connect = false;
            int variantIndex = 0;

            DA.GetData(0, ref url);
            DA.GetData(1, ref connect);
            DA.GetData(2, ref variantIndex);

            if (connect)
            {
                EnsureConnected(url);
            }
            else
            {
                EnsureDisconnected();
            }

            // Build geometry from latest data
            lock (_lock)
            {
                if (_latestData != null && _dataChanged)
                {
                    _builder.Build(_latestData);
                    _dataChanged = false;
                }
            }

            // Set outputs
            DA.SetDataList(0, _builder.Walls);
            DA.SetDataList(1, _builder.Slabs);
            DA.SetDataList(2, _builder.WindowGlass);
            DA.SetDataList(3, _builder.DoorPanels);
            DA.SetDataList(4, _builder.BathroomPods);
            DA.SetDataList(5, _builder.BalconySlabs);
            DA.SetDataList(6, _builder.RoomOutlines);
            DA.SetDataList(7, _builder.ApartmentOutlines);
            DA.SetDataList(8, _builder.GridLines);
            DA.SetDataList(9, _builder.FurnitureZones);
            DA.SetDataList(10, _builder.Labels);
            DA.SetData(11, _status);
        }

        private void EnsureConnected(string url)
        {
            if (_client != null && _client.IsConnected) return;

            _client?.Dispose();
            _client = new SyncClient(url);
            // Share client with the GoldbeckEdit component for bidirectional sync
            GoldbeckEditComponent.SetSharedClient(_client);

            _client.FloorPlansReceived += data =>
            {
                lock (_lock)
                {
                    _latestData = data;
                    _dataChanged = true;
                    _status = $"Connected | {data.TotalApartments} apts | {data.NumStories} stories";
                }
                // Schedule recompute on the main Grasshopper thread
                Rhino.RhinoApp.InvokeOnUiThread((Action)(() => ExpireSolution(true)));
            };

            _client.ProgressReceived += prog =>
            {
                lock (_lock)
                {
                    _status = $"Optimizing: Gen {prog.Generation}/{prog.TotalGenerations} " +
                              $"({prog.Pct:F0}%) | Best: {prog.BestFitness:F2}";
                }
                Rhino.RhinoApp.InvokeOnUiThread((Action)(() => ExpireSolution(true)));
            };

            _client.OptimizationComplete += comp =>
            {
                lock (_lock)
                {
                    _status = $"Complete | {comp.NumVariants} variants";
                }
                Rhino.RhinoApp.InvokeOnUiThread((Action)(() => ExpireSolution(true)));
            };

            _client.ConnectionStateChanged += connected =>
            {
                lock (_lock)
                {
                    _status = connected ? "Connected (waiting for data...)" : "Disconnected";
                }
                if (connected)
                    _client.RequestFullState();
                Rhino.RhinoApp.InvokeOnUiThread((Action)(() => ExpireSolution(true)));
            };

            _client.ErrorOccurred += error =>
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"WS: {error}");
            };

            _client.Connect();
            _status = "Connecting...";
        }

        private void EnsureDisconnected()
        {
            if (_client == null) return;
            _client.Disconnect();
            _client.Dispose();
            _client = null;
            _status = "Disconnected";
        }

        public override void RemovedFromDocument(GH_Document document)
        {
            EnsureDisconnected();
            base.RemovedFromDocument(document);
        }
    }
}
