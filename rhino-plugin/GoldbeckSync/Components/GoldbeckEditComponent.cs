using System;
using System.Collections.Generic;
using System.Drawing;
using Grasshopper.Kernel;
using Rhino.Geometry;
using GoldbeckSync.Protocol;

namespace GoldbeckSync.Components
{
    /// <summary>
    /// Bidirectional edit component: sends manual Grasshopper edits
    /// back to the Python optimizer so the user can override room sizes,
    /// apartment boundaries, or constraints from within Rhino/GH.
    ///
    /// Inputs:
    ///   - Client: reference to the SyncClient from the main GoldbeckSync component
    ///   - RoomId: ID of the room being edited
    ///   - NewBounds: manually edited bounding rectangle (from GH geometry)
    ///   - ParamName: name of a parameter to override
    ///   - ParamValue: new value for the parameter
    ///   - Send: button/boolean trigger to send the edit
    ///
    /// Outputs:
    ///   - Status: confirmation message
    /// </summary>
    public class GoldbeckEditComponent : GH_Component
    {
        private static SyncClient _sharedClient;

        /// <summary>
        /// Allow the main sync component to share its client instance.
        /// </summary>
        public static void SetSharedClient(SyncClient client)
        {
            _sharedClient = client;
        }

        public GoldbeckEditComponent()
            : base(
                "Goldbeck Edit",
                "GBEdit",
                "Send manual geometry edits or parameter overrides back to the optimizer.",
                "Goldbeck",
                "Sync")
        { }

        public override Guid ComponentGuid => new Guid("c3d4e5f6-a7b8-9012-cdef-123456789012");

        protected override Bitmap Icon => null;

        protected override void RegisterInputParams(GH_InputParamManager pManager)
        {
            pManager.AddTextParameter("RoomId", "RID",
                "ID of the room to edit (from optimizer data)", GH_ParamAccess.item);
            pManager[0].Optional = true;

            pManager.AddRectangleParameter("NewBounds", "Bounds",
                "New bounding rectangle for the room (XY plane)", GH_ParamAccess.item);
            pManager[1].Optional = true;

            pManager.AddTextParameter("ParamName", "Param",
                "Parameter name to override (e.g., 'building_width_m', 'stories')", GH_ParamAccess.item);
            pManager[2].Optional = true;

            pManager.AddNumberParameter("ParamValue", "Val",
                "New value for the parameter", GH_ParamAccess.item);
            pManager[3].Optional = true;

            pManager.AddIntegerParameter("VariantIndex", "V",
                "Request a specific variant (0 = best)", GH_ParamAccess.item, 0);
            pManager[4].Optional = true;

            pManager.AddBooleanParameter("Send", "Go",
                "Trigger to send the edit", GH_ParamAccess.item, false);
        }

        protected override void RegisterOutputParams(GH_OutputParamManager pManager)
        {
            pManager.AddTextParameter("Status", "St", "Result of the edit operation", GH_ParamAccess.item);
        }

        protected override void SolveInstance(IGH_DataAccess DA)
        {
            bool send = false;
            DA.GetData(5, ref send);

            if (!send)
            {
                DA.SetData(0, "Ready — set Send=True to push edits");
                return;
            }

            if (_sharedClient == null || !_sharedClient.IsConnected)
            {
                DA.SetData(0, "Error: Not connected. Place a GoldbeckSync component and connect first.");
                AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "No active WebSocket connection.");
                return;
            }

            var messages = new List<string>();

            // --- Geometry edit ---
            string roomId = null;
            Rectangle3d bounds = Rectangle3d.Unset;
            if (DA.GetData(0, ref roomId) && DA.GetData(1, ref bounds))
            {
                var corners = bounds.Corner(0);
                var opposite = bounds.Corner(2);
                _sharedClient.SendGeometryEdit(roomId, new double[]
                {
                    corners.X, corners.Y, opposite.X, opposite.Y
                });
                messages.Add($"Sent geometry edit: {roomId} → [{corners.X:F2},{corners.Y:F2}]-[{opposite.X:F2},{opposite.Y:F2}]");
            }

            // --- Parameter override ---
            string paramName = null;
            double paramValue = 0;
            if (DA.GetData(2, ref paramName) && DA.GetData(3, ref paramValue))
            {
                _sharedClient.SendParameterOverride(paramName, paramValue);
                messages.Add($"Sent parameter: {paramName} = {paramValue}");
            }

            // --- Variant request ---
            int variantIdx = 0;
            if (DA.GetData(4, ref variantIdx))
            {
                _sharedClient.RequestVariant(variantIdx);
                messages.Add($"Requested variant #{variantIdx}");
            }

            DA.SetData(0, messages.Count > 0
                ? string.Join(" | ", messages)
                : "Send triggered but no inputs provided.");
        }
    }
}
