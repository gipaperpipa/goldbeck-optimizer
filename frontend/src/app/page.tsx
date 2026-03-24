"use client";

import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Building2,
  MapPin,
  BarChart3,
  FolderOpen,
  Database,
  Users,
  Clock,
  Plus,
} from "lucide-react";
import { useProjects } from "@/hooks/use-projects";

const STATUS_LABELS: Record<string, string> = {
  prospecting: "Akquise",
  negotiating: "Verhandlung",
  planning: "Planung",
  approved: "Genehmigt",
  under_construction: "Im Bau",
  completed: "Abgeschlossen",
  abandoned: "Aufgegeben",
};

const STATUS_COLORS: Record<string, string> = {
  prospecting: "bg-gray-100 text-gray-700",
  negotiating: "bg-amber-100 text-amber-700",
  planning: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  under_construction: "bg-purple-100 text-purple-700",
  completed: "bg-emerald-100 text-emerald-700",
  abandoned: "bg-red-100 text-red-700",
};

export default function HomePage() {
  const { projects, stats, isLoading } = useProjects();

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-6 h-6" />
            <span className="font-bold text-lg">Goldbeck Optimizer</span>
          </div>
          <Link href="/project/new">
            <Button size="sm">
              <Plus className="w-4 h-4 mr-1.5" />
              Neues Projekt
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Stats Row */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <StatCard
              icon={<MapPin className="w-5 h-5 text-blue-500" />}
              label="Flurst\u00FCcke"
              value={stats.total_parcels}
            />
            <StatCard
              icon={<FolderOpen className="w-5 h-5 text-green-500" />}
              label="Projekte"
              value={stats.total_projects}
            />
            <StatCard
              icon={<Users className="w-5 h-5 text-purple-500" />}
              label="Kontakte"
              value={stats.total_contacts}
            />
            <StatCard
              icon={<Clock className="w-5 h-5 text-amber-500" />}
              label="Aktivit\u00E4ten"
              value={stats.total_timeline_entries}
            />
          </div>
        )}

        {/* Projects List */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Projekte</h2>
            <Link href="/project/new">
              <Button variant="outline" size="sm">
                <Plus className="w-4 h-4 mr-1" />
                Neues Projekt
              </Button>
            </Link>
          </div>

          {isLoading && (
            <div className="text-center py-8 text-neutral-500 text-sm">
              Projekte werden geladen...
            </div>
          )}

          {!isLoading && projects.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <Database className="w-10 h-10 mx-auto mb-3 text-neutral-300" />
                <p className="text-neutral-500 mb-4">
                  Noch keine Projekte vorhanden.
                </p>
                <Link href="/project/new">
                  <Button>
                    <Plus className="w-4 h-4 mr-1.5" />
                    Erstes Projekt erstellen
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {!isLoading && projects.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <Link key={project.id} href={`/project/${project.id}`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">
                          {project.name}
                        </CardTitle>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            STATUS_COLORS[project.status] ||
                            "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {STATUS_LABELS[project.status] || project.status}
                        </span>
                      </div>
                      {project.address && (
                        <CardDescription className="text-xs">
                          {project.address}
                        </CardDescription>
                      )}
                    </CardHeader>
                    <CardContent>
                      <div className="flex gap-4 text-xs text-neutral-500">
                        <span>{project.parcel_count} Flurst\u00FCcke</span>
                        {project.total_area_sqm ? (
                          <span>
                            {project.total_area_sqm.toFixed(0)} m\u00B2
                          </span>
                        ) : null}
                        {project.target_units && (
                          <span>{project.target_units} WE</span>
                        )}
                      </div>
                      {project.description && (
                        <p className="text-xs text-neutral-400 mt-2 line-clamp-2">
                          {project.description}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <FeatureCard
            icon={<MapPin className="w-8 h-8 text-blue-500" />}
            title="Katasterkarte"
            description="Flurst\u00FCcke auf der Karte suchen und ausw\u00E4hlen."
            href="/project/new"
          />
          <FeatureCard
            icon={<Building2 className="w-8 h-8 text-green-500" />}
            title="Layout-Optimierung"
            description="Geb\u00E4udeplatzierung mit genetischem Algorithmus optimieren."
            href="/project/new"
          />
          <FeatureCard
            icon={<BarChart3 className="w-8 h-8 text-purple-500" />}
            title="Wirtschaftlichkeit"
            description="Vollst\u00E4ndige Entwicklungskostenanalyse und Renditeberechnung."
            href="/project/new"
          />
          <FeatureCard
            icon={<Database className="w-8 h-8 text-amber-500" />}
            title="Datenbank"
            description="Alle gespeicherten Flurst\u00FCcke, Projekte und Kontakte."
            href="/project/new"
          />
        </div>
      </main>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="py-4 flex items-center gap-3">
        {icon}
        <div>
          <p className="text-2xl font-bold">{value.toLocaleString("de-DE")}</p>
          <p className="text-xs text-neutral-500">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function FeatureCard({
  icon,
  title,
  description,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardHeader>
          {icon}
          <CardTitle className="mt-2 text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription>{description}</CardDescription>
        </CardContent>
      </Card>
    </Link>
  );
}
