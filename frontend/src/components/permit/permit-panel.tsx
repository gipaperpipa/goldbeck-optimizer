"use client";

/**
 * Permit-readiness dashboard (Phase 5h).
 *
 * Aggregates every validator we own into one "Baugenehmigungsfähigkeit"
 * verdict for the currently selected layout. Each check row shows its
 * regulation reference, status pill, issue counts, and a click-through
 * to the relevant detail tab.
 */

import { useMemo } from "react";
import { ShieldCheck, AlertTriangle, XCircle, ChevronRight, MinusCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useProjectStore } from "@/stores/project-store";
import {
  analyzePermitReadiness,
  verdictLabel,
  verdictColorClasses,
  statusColorClasses,
  statusLabel,
  type PermitCheck,
  type CheckStatus,
} from "@/lib/permit-readiness";

function StatusIcon({ status }: { status: CheckStatus }) {
  const cls = "w-5 h-5 shrink-0";
  switch (status) {
    case "pass":
      return <ShieldCheck className={`${cls} text-emerald-600`} />;
    case "warn":
      return <AlertTriangle className={`${cls} text-amber-600`} />;
    case "fail":
      return <XCircle className={`${cls} text-rose-600`} />;
    case "skipped":
      return <MinusCircle className={`${cls} text-neutral-400`} />;
  }
}

function CheckRow({
  check,
  onJump,
}: {
  check: PermitCheck;
  onJump: (tab?: string) => void;
}) {
  const clickable = !!check.targetTab;
  return (
    <button
      type="button"
      onClick={() => (clickable ? onJump(check.targetTab) : undefined)}
      disabled={!clickable}
      className={`w-full text-left flex items-start gap-3 px-4 py-3 border-b last:border-b-0 transition-colors ${
        clickable ? "hover:bg-neutral-50 cursor-pointer" : "cursor-default"
      }`}
    >
      <StatusIcon status={check.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-neutral-900">{check.label}</span>
          <span className="text-xs text-neutral-500">{check.regulation}</span>
        </div>
        <p className="text-sm text-neutral-600 mt-0.5">{check.detail}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded border ${statusColorClasses(
            check.status,
          )}`}
        >
          {statusLabel(check.status)}
          {check.errorCount > 0 && ` · ${check.errorCount}`}
          {check.errorCount === 0 && check.warnCount > 0 && ` · ${check.warnCount}`}
        </span>
        {clickable && <ChevronRight className="w-4 h-4 text-neutral-400" />}
      </div>
    </button>
  );
}

export function PermitPanel() {
  const { selectedLayout, floorPlans, plotAnalysis, setActiveTab } =
    useProjectStore();

  const result = useMemo(() => {
    if (!selectedLayout) return null;
    return analyzePermitReadiness({
      layout: selectedLayout,
      floorPlans,
      plot: plotAnalysis,
    });
  }, [selectedLayout, floorPlans, plotAnalysis]);

  if (!selectedLayout) {
    return (
      <div className="text-center py-16 text-neutral-500">
        Bitte wählen Sie zuerst ein Layout im Layouts-Tab aus.
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="space-y-6">
      {/* Overall verdict */}
      <div
        className={`border rounded-lg p-6 ${verdictColorClasses(result.overall)}`}
      >
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide opacity-75 mb-1">
              Baugenehmigungsfähigkeit
            </p>
            <h2 className="text-2xl font-bold">{verdictLabel(result.overall)}</h2>
            <p className="text-sm mt-1 opacity-90">
              {result.errorCount === 0 && result.warnCount === 0 && (
                <>Alle {result.checks.length} Prüfungen erfüllt.</>
              )}
              {result.errorCount === 0 && result.warnCount > 0 && (
                <>
                  Keine Verstöße, aber {result.warnCount}{" "}
                  {result.warnCount === 1 ? "Hinweis" : "Hinweise"} zu
                  beachten.
                </>
              )}
              {result.errorCount > 0 && (
                <>
                  {result.errorCount}{" "}
                  {result.errorCount === 1 ? "Verstoß" : "Verstöße"}
                  {result.warnCount > 0 && <> und {result.warnCount} Hinweise</>}{" "}
                  müssen vor der Einreichung behoben werden.
                </>
              )}
            </p>
          </div>
          <div className="flex gap-6 text-center">
            <div>
              <div className="text-3xl font-bold text-rose-700">
                {result.errorCount}
              </div>
              <div className="text-xs uppercase tracking-wide opacity-70">
                Verstöße
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-amber-700">
                {result.warnCount}
              </div>
              <div className="text-xs uppercase tracking-wide opacity-70">
                Hinweise
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-emerald-700">
                {
                  result.checks.filter((c) => c.status === "pass").length
                }
              </div>
              <div className="text-xs uppercase tracking-wide opacity-70">
                Erfüllt
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Per-check breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Einzelprüfungen</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t">
            {result.checks.map((c) => (
              <CheckRow
                key={c.id}
                check={c}
                onJump={(tab) => tab && setActiveTab(tab)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-neutral-500 leading-relaxed">
        Diese Zusammenfassung ist eine automatisierte Vor-Prüfung der
        wichtigsten baurechtlich relevanten Kriterien. Sie ersetzt keine
        formale Prüfung durch die Bauaufsichtsbehörde und keine
        Leistungsphase-4-Genehmigungsplanung. Maßgeblich bleibt die
        Prüfung durch den Entwurfsverfasser und die zuständige Behörde
        gemäß BauO NRW §67 ff.
      </p>
    </div>
  );
}
