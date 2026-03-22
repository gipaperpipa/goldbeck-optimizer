using System;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using WebSocketSharp;

namespace GoldbeckSync.Protocol
{
    /// <summary>
    /// WebSocket client that connects to the Python optimizer backend
    /// and receives live floor plan updates.
    /// </summary>
    public class SyncClient : IDisposable
    {
        private WebSocket _ws;
        private readonly string _url;
        private bool _disposed;
        private Timer _reconnectTimer;
        private int _reconnectAttempts;

        /// <summary>Fires when complete floor plan data is received.</summary>
        public event Action<BuildingData> FloorPlansReceived;

        /// <summary>Fires when optimization progress updates arrive.</summary>
        public event Action<ProgressData> ProgressReceived;

        /// <summary>Fires when optimization completes with all variants.</summary>
        public event Action<CompletionData> OptimizationComplete;

        /// <summary>Fires when connection state changes.</summary>
        public event Action<bool> ConnectionStateChanged;

        /// <summary>Fires on any error.</summary>
        public event Action<string> ErrorOccurred;

        public bool IsConnected => _ws?.ReadyState == WebSocketState.Open;

        public SyncClient(string url = "ws://localhost:8000/ws/sync")
        {
            _url = url;
        }

        public void Connect()
        {
            if (_ws != null)
            {
                _ws.Close();
                _ws = null;
            }

            _ws = new WebSocket(_url);

            _ws.OnOpen += (s, e) =>
            {
                _reconnectAttempts = 0;
                ConnectionStateChanged?.Invoke(true);
            };

            _ws.OnClose += (s, e) =>
            {
                ConnectionStateChanged?.Invoke(false);
                ScheduleReconnect();
            };

            _ws.OnError += (s, e) =>
            {
                ErrorOccurred?.Invoke(e.Message);
            };

            _ws.OnMessage += (s, e) =>
            {
                if (!e.IsText) return;
                try
                {
                    HandleMessage(e.Data);
                }
                catch (Exception ex)
                {
                    ErrorOccurred?.Invoke($"Parse error: {ex.Message}");
                }
            };

            _ws.ConnectAsync();
        }

        public void Disconnect()
        {
            _reconnectTimer?.Dispose();
            _reconnectTimer = null;
            _ws?.Close();
        }

        /// <summary>
        /// Send a parameter override back to the optimizer.
        /// </summary>
        public void SendParameterOverride(string paramName, object value)
        {
            Send(new
            {
                type = "parameter_override",
                payload = new { parameter = paramName, value }
            });
        }

        /// <summary>
        /// Send a geometry edit from Grasshopper back to the optimizer.
        /// </summary>
        public void SendGeometryEdit(string roomId, double[] newBounds)
        {
            Send(new
            {
                type = "geometry_edit",
                payload = new { room_id = roomId, bounds = newBounds }
            });
        }

        /// <summary>
        /// Request a specific variant to be displayed.
        /// </summary>
        public void RequestVariant(int variantIndex)
        {
            Send(new
            {
                type = "request_variant",
                payload = new { variant_index = variantIndex }
            });
        }

        /// <summary>
        /// Request the full current state (useful after reconnect).
        /// </summary>
        public void RequestFullState()
        {
            Send(new { type = "request_full_state" });
        }

        private void Send(object message)
        {
            if (!IsConnected) return;
            _ws.Send(JsonConvert.SerializeObject(message));
        }

        private void HandleMessage(string json)
        {
            var obj = JObject.Parse(json);
            var msgType = obj["type"]?.ToString();
            var payload = obj["payload"];

            switch (msgType)
            {
                case "floor_plans":
                case "full_state":
                    var data = payload?.ToObject<BuildingData>();
                    if (data != null) FloorPlansReceived?.Invoke(data);
                    break;

                case "progress":
                    var prog = payload?.ToObject<ProgressData>();
                    if (prog != null) ProgressReceived?.Invoke(prog);
                    break;

                case "optimization_complete":
                    var comp = payload?.ToObject<CompletionData>();
                    if (comp != null) OptimizationComplete?.Invoke(comp);
                    break;

                case "variant_selected":
                    var vs = payload?["building_floor_plans"]?.ToObject<BuildingData>();
                    if (vs != null) FloorPlansReceived?.Invoke(vs);
                    break;

                case "pong":
                    break;

                default:
                    ErrorOccurred?.Invoke($"Unknown message type: {msgType}");
                    break;
            }
        }

        private void ScheduleReconnect()
        {
            if (_disposed) return;
            _reconnectAttempts++;
            var delay = Math.Min(30000, 1000 * _reconnectAttempts); // Exponential backoff, max 30s
            _reconnectTimer = new Timer(_ =>
            {
                if (!_disposed && !IsConnected)
                    Connect();
            }, null, delay, Timeout.Infinite);
        }

        public void Dispose()
        {
            _disposed = true;
            _reconnectTimer?.Dispose();
            _ws?.Close();
        }
    }

    // --- Data classes matching the Python Pydantic models ---

    public class ProgressData
    {
        [JsonProperty("generation")] public int Generation { get; set; }
        [JsonProperty("total_generations")] public int TotalGenerations { get; set; }
        [JsonProperty("best_fitness")] public double BestFitness { get; set; }
        [JsonProperty("avg_fitness")] public double AvgFitness { get; set; }
        [JsonProperty("pct")] public double Pct { get; set; }
    }

    public class CompletionData
    {
        [JsonProperty("num_variants")] public int NumVariants { get; set; }
        [JsonProperty("best_variant")] public JObject BestVariant { get; set; }
    }

    public class Point2D
    {
        [JsonProperty("x")] public double X { get; set; }
        [JsonProperty("y")] public double Y { get; set; }
    }

    public class WallData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("wall_type")] public string WallType { get; set; }
        [JsonProperty("start")] public Point2D Start { get; set; }
        [JsonProperty("end")] public Point2D End { get; set; }
        [JsonProperty("thickness_m")] public double Thickness { get; set; }
        [JsonProperty("is_bearing")] public bool IsBearing { get; set; }
        [JsonProperty("is_exterior")] public bool IsExterior { get; set; }
    }

    public class DoorData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("position")] public Point2D Position { get; set; }
        [JsonProperty("width_m")] public double Width { get; set; }
        [JsonProperty("height_m")] public double Height { get; set; }
        [JsonProperty("is_entrance")] public bool IsEntrance { get; set; }
    }

    public class WindowData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("position")] public Point2D Position { get; set; }
        [JsonProperty("width_m")] public double Width { get; set; }
        [JsonProperty("height_m")] public double Height { get; set; }
        [JsonProperty("sill_height_m")] public double SillHeight { get; set; }
        [JsonProperty("is_floor_to_ceiling")] public bool IsFloorToCeiling { get; set; }
    }

    public class RoomData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("room_type")] public string RoomType { get; set; }
        [JsonProperty("polygon")] public Point2D[] Polygon { get; set; }
        [JsonProperty("area_sqm")] public double Area { get; set; }
        [JsonProperty("label")] public string Label { get; set; }
        [JsonProperty("apartment_id")] public string ApartmentId { get; set; }
    }

    public class BathroomData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("bathroom_type")] public string BathroomType { get; set; }
        [JsonProperty("position")] public Point2D Position { get; set; }
        [JsonProperty("width_m")] public double Width { get; set; }
        [JsonProperty("depth_m")] public double Depth { get; set; }
    }

    public class ApartmentData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("apartment_type")] public string ApartmentType { get; set; }
        [JsonProperty("unit_number")] public string UnitNumber { get; set; }
        [JsonProperty("side")] public string Side { get; set; }
        [JsonProperty("rooms")] public RoomData[] Rooms { get; set; }
        [JsonProperty("bathroom")] public BathroomData Bathroom { get; set; }
        [JsonProperty("total_area_sqm")] public double TotalArea { get; set; }
        [JsonProperty("has_balcony")] public bool HasBalcony { get; set; }
    }

    public class StaircaseData
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("staircase_type")] public string StaircaseType { get; set; }
        [JsonProperty("position")] public Point2D Position { get; set; }
        [JsonProperty("width_m")] public double Width { get; set; }
        [JsonProperty("depth_m")] public double Depth { get; set; }
        [JsonProperty("has_elevator")] public bool HasElevator { get; set; }
    }

    public class GridData
    {
        [JsonProperty("bay_widths")] public double[] BayWidths { get; set; }
        [JsonProperty("building_depth_m")] public double BuildingDepth { get; set; }
        [JsonProperty("building_length_m")] public double BuildingLength { get; set; }
        [JsonProperty("corridor_width_m")] public double CorridorWidth { get; set; }
        [JsonProperty("corridor_y_start_m")] public double CorridorYStart { get; set; }
        [JsonProperty("story_height_m")] public double StoryHeight { get; set; }
        [JsonProperty("axis_positions_x")] public double[] AxisPositionsX { get; set; }
    }

    public class FloorPlanData
    {
        [JsonProperty("floor_index")] public int FloorIndex { get; set; }
        [JsonProperty("structural_grid")] public GridData Grid { get; set; }
        [JsonProperty("walls")] public WallData[] Walls { get; set; }
        [JsonProperty("doors")] public DoorData[] Doors { get; set; }
        [JsonProperty("windows")] public WindowData[] Windows { get; set; }
        [JsonProperty("apartments")] public ApartmentData[] Apartments { get; set; }
        [JsonProperty("staircases")] public StaircaseData[] Staircases { get; set; }
        [JsonProperty("rooms")] public RoomData[] Rooms { get; set; }
        [JsonProperty("access_type")] public string AccessType { get; set; }
        [JsonProperty("gross_area_sqm")] public double GrossArea { get; set; }
        [JsonProperty("net_area_sqm")] public double NetArea { get; set; }
    }

    public class BuildingData
    {
        [JsonProperty("building_id")] public string BuildingId { get; set; }
        [JsonProperty("construction_system")] public string ConstructionSystem { get; set; }
        [JsonProperty("building_width_m")] public double BuildingWidth { get; set; }
        [JsonProperty("building_depth_m")] public double BuildingDepth { get; set; }
        [JsonProperty("num_stories")] public int NumStories { get; set; }
        [JsonProperty("story_height_m")] public double StoryHeight { get; set; }
        [JsonProperty("access_type")] public string AccessType { get; set; }
        [JsonProperty("structural_grid")] public GridData StructuralGrid { get; set; }
        [JsonProperty("floor_plans")] public FloorPlanData[] FloorPlans { get; set; }
        [JsonProperty("total_apartments")] public int TotalApartments { get; set; }
    }
}
