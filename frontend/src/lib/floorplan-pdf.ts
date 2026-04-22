/**
 * DIN A3 PDF export for floor plans (Phase 4.2).
 *
 * Renders the plan into a publication-quality PDF with a proper
 * architectural title block. The plan is re-rendered at 1:100 scale to
 * an offscreen canvas so the output is independent of the viewer's
 * current zoom/pan, then embedded as an image into a DIN A3 landscape
 * (420×297mm) PDF via jsPDF.
 *
 * The export intentionally calls back into a caller-provided `drawPlan`
 * function so the PDF gets the exact same linework as the on-screen
 * renderer — no duplicate drawing code to drift out of sync.
 */

import jsPDF from "jspdf";
import type { FloorPlan } from "@/types/api";

// ── Paper constants (mm) ──────────────────────────────────────────

const A3_WIDTH_MM = 420;
const A3_HEIGHT_MM = 297;
const MARGIN_MM = 15;
const TITLE_BLOCK_WIDTH_MM = 90;
const TITLE_BLOCK_HEIGHT_MM = 50;

/** Per-mm DPI for the rasterized plan. 300 DPI @ mm = 11.811 px/mm.
 *  We use 200 DPI (~7.874 px/mm) to keep file size reasonable while
 *  staying sharp at A3 printing. */
const EXPORT_DPI = 200;
const PX_PER_MM = EXPORT_DPI / 25.4;

export interface PdfTitleBlock {
  projectName: string;
  buildingName?: string;
  floorLabel: string;
  /** Scale numerator after ":" — e.g. 100 for "1:100". Determined
   *  automatically based on plan size if not provided. */
  scaleDenominator?: number;
  /** Freeform text below the title. */
  notes?: string;
  /** ISO date string (YYYY-MM-DD). Defaults to today. */
  drawnDate?: string;
  /** Drawing number / revision. */
  drawingNumber?: string;
  /** Draughtsman / architect. */
  author?: string;
}

export interface ExportPdfOptions {
  plan: FloorPlan;
  title: PdfTitleBlock;
  /** Caller-provided draw function — receives the offscreen context +
   *  the same (tx, ty, ts, width, height) that the screen viewer uses,
   *  so the PDF is pixel-identical to the screen (minus UI chrome). */
  drawPlan: (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    scaleMmPerM: number,
  ) => void;
}

// ── Scale selection ───────────────────────────────────────────────

/** Returns the largest standard architectural scale denominator
 *  (1:50, 1:100, 1:200, 1:500) at which the plan fits in the
 *  available paper area with the given margins. */
function pickScale(planWidthM: number, planHeightM: number, availW: number, availH: number): number {
  const standardScales = [50, 100, 200, 500];
  for (const s of standardScales) {
    const mmW = (planWidthM * 1000) / s;
    const mmH = (planHeightM * 1000) / s;
    if (mmW <= availW && mmH <= availH) return s;
  }
  return 500;
}

// ── Offscreen rasterization ───────────────────────────────────────

/** Render the plan to an offscreen canvas at the given architectural
 *  scale. Returns a PNG data URL suitable for jsPDF.addImage().
 *
 *  The caller's drawPlan sees the canvas like the on-screen one: a
 *  (width, height) in pixels and an implicit transform derived from
 *  the plan's bbox + padding. We hand it a scaleMmPerM constant so it
 *  can decide whether to draw dimension strings or thicken lines. */
function rasterize(
  plan: FloorPlan,
  scaleDenominator: number,
  drawPlan: ExportPdfOptions["drawPlan"],
): { dataUrl: string; widthMm: number; heightMm: number } {
  const grid = plan.structural_grid;
  const planW = grid.building_length_m;
  const planH = grid.building_depth_m;

  // Plan dimensions in paper-mm after scaling
  const planMmW = (planW * 1000) / scaleDenominator;
  const planMmH = (planH * 1000) / scaleDenominator;
  // Add 5mm breathing room on each side for dimension strings
  const paddingMm = 8;
  const totalMmW = planMmW + 2 * paddingMm;
  const totalMmH = planMmH + 2 * paddingMm;

  const pxW = Math.round(totalMmW * PX_PER_MM);
  const pxH = Math.round(totalMmH * PX_PER_MM);

  const canvas = document.createElement("canvas");
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context for PDF rasterization");

  // White background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pxW, pxH);

  drawPlan(ctx, pxW, pxH, PX_PER_MM * (1000 / scaleDenominator));

  return {
    dataUrl: canvas.toDataURL("image/png"),
    widthMm: totalMmW,
    heightMm: totalMmH,
  };
}

// ── Title block ───────────────────────────────────────────────────

function drawTitleBlock(pdf: jsPDF, tb: Required<PdfTitleBlock>, x: number, y: number) {
  const W = TITLE_BLOCK_WIDTH_MM;
  const H = TITLE_BLOCK_HEIGHT_MM;

  // Outer border
  pdf.setDrawColor(30);
  pdf.setLineWidth(0.4);
  pdf.rect(x, y, W, H);

  // Header strip — Goldbeck branding placeholder
  pdf.setFillColor(30, 26, 21);
  pdf.rect(x, y, W, 8, "F");
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.text("GOLDBECK — Residential Planning", x + 3, y + 5.6);

  // Body grid
  pdf.setTextColor(0);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7);
  pdf.setLineWidth(0.15);

  const cells: Array<{ col: number; row: number; label: string; value: string }> = [
    { col: 0, row: 0, label: "Projekt", value: tb.projectName },
    { col: 1, row: 0, label: "Gebäude", value: tb.buildingName },
    { col: 0, row: 1, label: "Geschoss", value: tb.floorLabel },
    { col: 1, row: 1, label: "Maßstab", value: `1 : ${tb.scaleDenominator}` },
    { col: 0, row: 2, label: "Datum", value: tb.drawnDate },
    { col: 1, row: 2, label: "Zeichnung Nr.", value: tb.drawingNumber },
    { col: 0, row: 3, label: "Bearbeitet", value: tb.author },
    { col: 1, row: 3, label: "Format", value: "DIN A3 quer" },
  ];

  const bodyTop = y + 8;
  const cellH = 8;
  const colW = W / 2;

  for (const c of cells) {
    const cx = x + c.col * colW;
    const cy = bodyTop + c.row * cellH;
    pdf.rect(cx, cy, colW, cellH);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(6);
    pdf.setTextColor(110);
    pdf.text(c.label.toUpperCase(), cx + 1.5, cy + 2.5);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(20);
    // Truncate long values to fit cell
    const maxChars = 28;
    const v = c.value.length > maxChars ? c.value.slice(0, maxChars - 1) + "…" : c.value;
    pdf.text(v, cx + 1.5, cy + 6);
  }

  // Notes row (full width at the bottom if any notes)
  if (tb.notes) {
    const notesY = bodyTop + 4 * cellH;
    if (notesY + 6 <= y + H) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(60);
      pdf.text(tb.notes.slice(0, 70), x + 2, notesY + 4);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────

/** Render a single plan onto the CURRENT page of the given jsPDF instance.
 *  Shared between single-plan and multi-plan exports — the multi-plan
 *  variant just calls `pdf.addPage()` between invocations. */
function renderPlanPage(pdf: jsPDF, opts: ExportPdfOptions): void {
  const { plan, title, drawPlan } = opts;

  // Available plan area = sheet minus margins minus title block (right side)
  const availW = A3_WIDTH_MM - 2 * MARGIN_MM - TITLE_BLOCK_WIDTH_MM - 5;
  const availH = A3_HEIGHT_MM - 2 * MARGIN_MM;

  const grid = plan.structural_grid;
  const scaleDenominator =
    title.scaleDenominator ?? pickScale(grid.building_length_m, grid.building_depth_m, availW, availH);

  const { dataUrl, widthMm, heightMm } = rasterize(plan, scaleDenominator, drawPlan);

  // Plan-area placement: centered within the available zone
  const planZoneX = MARGIN_MM;
  const planZoneY = MARGIN_MM;
  const planZoneW = availW;
  const planZoneH = availH;
  const planX = planZoneX + Math.max(0, (planZoneW - widthMm) / 2);
  const planY = planZoneY + Math.max(0, (planZoneH - heightMm) / 2);

  pdf.addImage(dataUrl, "PNG", planX, planY, widthMm, heightMm);

  // Outer sheet border (2mm from edge — architectural convention)
  pdf.setDrawColor(30);
  pdf.setLineWidth(0.6);
  pdf.rect(5, 5, A3_WIDTH_MM - 10, A3_HEIGHT_MM - 10);

  // Title block: right side, bottom-aligned
  const tbX = A3_WIDTH_MM - MARGIN_MM - TITLE_BLOCK_WIDTH_MM;
  const tbY = A3_HEIGHT_MM - MARGIN_MM - TITLE_BLOCK_HEIGHT_MM;
  const resolved: Required<PdfTitleBlock> = {
    projectName: title.projectName,
    buildingName: title.buildingName || "—",
    floorLabel: title.floorLabel,
    scaleDenominator,
    notes: title.notes ?? "",
    drawnDate: title.drawnDate ?? new Date().toISOString().slice(0, 10),
    drawingNumber: title.drawingNumber ?? "001",
    author: title.author ?? "—",
  };
  drawTitleBlock(pdf, resolved, tbX, tbY);
}

/** Build and trigger download of a DIN A3 landscape PDF for the given
 *  floor plan. Scale is auto-picked. Returns the jsPDF instance so the
 *  caller can save under a custom filename or post-process. */
export function exportFloorPlanPdf(opts: ExportPdfOptions): jsPDF {
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a3",
    compress: true,
  });
  renderPlanPage(pdf, opts);
  return pdf;
}

/** Convenience wrapper: export + immediately trigger browser download. */
export function downloadFloorPlanPdf(opts: ExportPdfOptions, filename?: string): void {
  const pdf = exportFloorPlanPdf(opts);
  const name =
    filename ||
    `${opts.title.projectName || "floorplan"}_${opts.title.floorLabel}_1-${
      opts.title.scaleDenominator ?? "auto"
    }.pdf`.replace(/[^a-zA-Z0-9._-]/g, "_");
  pdf.save(name);
}

// ── Multi-plan batch export (Phase 5b) ────────────────────────────

export interface MultiPlanPdfOptions {
  /** Ordered list of pages to render. Each entry is a full
   *  ExportPdfOptions (its own plan + title + drawPlan). Typical usage
   *  is all floors of a building, or all floors × all buildings of a
   *  project. */
  pages: ExportPdfOptions[];
}

/** Build a multi-page A3 PDF containing every page in `opts.pages`, one
 *  plan per page, sharing the same title-block convention as the single
 *  export. Returns the jsPDF instance. Throws if `pages` is empty. */
export function exportMultiPlanPdf(opts: MultiPlanPdfOptions): jsPDF {
  if (!opts.pages || opts.pages.length === 0) {
    throw new Error("exportMultiPlanPdf: pages array is empty");
  }

  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a3",
    compress: true,
  });

  opts.pages.forEach((pageOpts, idx) => {
    if (idx > 0) pdf.addPage("a3", "landscape");
    renderPlanPage(pdf, pageOpts);
  });

  return pdf;
}

/** Convenience wrapper: build + save multi-page PDF. */
export function downloadMultiPlanPdf(opts: MultiPlanPdfOptions, filename?: string): void {
  const pdf = exportMultiPlanPdf(opts);
  const first = opts.pages[0]?.title;
  const name =
    filename ||
    `${first?.projectName || "project"}_${opts.pages.length}_Geschosse.pdf`.replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
  pdf.save(name);
}
