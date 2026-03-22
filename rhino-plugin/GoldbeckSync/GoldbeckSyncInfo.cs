using System;
using System.Drawing;
using Grasshopper.Kernel;

namespace GoldbeckSync
{
    public class GoldbeckSyncInfo : GH_AssemblyInfo
    {
        public override string Name => "GoldbeckSync";
        public override string Description => "Live-sync plugin connecting the Goldbeck floor plan optimizer to Rhino/Grasshopper via WebSocket.";
        public override Guid Id => new Guid("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
        public override string AuthorName => "a+a studio";
        public override string AuthorContact => "adrian.krasniqi@aplusa-studio.com";
        public override string Version => "1.0.0";
        public override Bitmap Icon => null;
    }
}
