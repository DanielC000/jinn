import { lazy, Suspense, useEffect, useMemo, useState, useRef, useCallback } from "react";
import type { Employee } from "@/lib/api";
import { EmployeeDetail } from "@/components/org/employee-detail";
import { GridView } from "@/components/org/grid-view";
import { FeedView } from "@/components/org/feed-view";
import { OrgTree } from "@/components/org/org-tree";
import { PageLayout } from "@/components/page-layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSettings } from "@/routes/settings-provider";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
import { useOrg } from "@/hooks/use-employees";

const OrgMap = lazy(() =>
  import("@/components/org/org-map").then((m) => ({ default: m.OrgMap })),
);

const OrgMapFallback = (
  <div className="flex flex-col items-center justify-center h-full gap-[var(--space-3)] text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
    Loading map...
  </div>
);

export default function OrgPage() {
  useBreadcrumbs([{ label: 'Organization' }])
  const [selected, setSelected] = useState<Employee | null>(null);
  const [view, setView] = useState<string>("map");
  const closeRef = useRef<HTMLButtonElement>(null);
  const { settings } = useSettings();

  // useOrg() reads useCurrentOrganisationId() and calls /api/org?organisation=<id>.
  // Without this the page would hit /api/org with no query, falling through to
  // scanOrg() server-side which unions every Organisation's employees.
  const { data, isLoading: loading, error, refetch } = useOrg();

  const employees = useMemo<Employee[]>(() => {
    if (!data) return [];
    const coo: Employee = {
      name: (settings.portalName ?? "Jinn").toLowerCase(),
      displayName: settings.portalName ?? "Jinn",
      department: "",
      rank: "executive",
      engine: "claude",
      model: "opus",
      persona: "COO and AI gateway daemon",
    };
    return [coo, ...data.employees];
  }, [data, settings.portalName]);

  const hierarchy = data?.hierarchy;

  // Focus close button when panel opens
  useEffect(() => {
    if (selected && closeRef.current) {
      closeRef.current.focus();
    }
  }, [selected]);

  // ESC closes panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && selected) {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected]);

  const handleSelectEmployee = useCallback((emp: Employee) => {
    setSelected(emp);
  }, []);

  if (error) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center h-full gap-[var(--space-4)] text-[var(--text-tertiary)]">
          <div className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}>
            Failed to load organization: {error instanceof Error ? error.message : String(error)}
          </div>
          <button
            onClick={() => refetch()}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md,12px)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-semibold)]"
          >
            Retry
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <div className="flex h-full relative bg-[var(--bg)]">
        {/* Main content area */}
        <div className="flex-1 h-full relative">
          <Tabs
            value={view}
            onValueChange={setView}
            className="h-full flex flex-col"
          >
            {/* Tab bar at top */}
            <div className="absolute top-[var(--space-4)] left-[var(--space-4)] z-10">
              <TabsList>
                <TabsTrigger value="map">Map</TabsTrigger>
                <TabsTrigger value="grid">Grid</TabsTrigger>
                <TabsTrigger value="list">List</TabsTrigger>
                <TabsTrigger value="tree">Tree</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="map" className="flex-1">
              {loading ? (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
                  Loading...
                </div>
              ) : (
                <Suspense fallback={OrgMapFallback}>
                  <OrgMap
                    employees={employees}
                    hierarchy={hierarchy}
                    selectedName={selected?.name ?? null}
                    onNodeClick={handleSelectEmployee}
                  />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="grid" className="flex-1 overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
                  Loading...
                </div>
              ) : (
                <GridView
                  employees={employees}
                  selectedName={selected?.name ?? null}
                  onSelect={handleSelectEmployee}
                />
              )}
            </TabsContent>

            <TabsContent value="list" className="flex-1 overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
                  Loading...
                </div>
              ) : (
                <FeedView
                  employees={employees}
                  selectedName={selected?.name ?? null}
                  onSelect={handleSelectEmployee}
                />
              )}
            </TabsContent>

            <TabsContent value="tree" className="flex-1 overflow-auto p-[var(--space-4)]">
              {loading ? (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
                  Loading...
                </div>
              ) : (
                <OrgTree
                  data={{
                    departments: [],
                    employees,
                    hierarchy: hierarchy ?? { root: null, sorted: [], warnings: [] },
                  }}
                  selectedEmployee={selected?.name ?? null}
                  selectedDepartment={null}
                  onSelectEmployee={(name) => {
                    const emp = employees.find((e) => e.name === name);
                    if (emp) handleSelectEmployee(emp);
                  }}
                  onSelectDepartment={() => {}}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>

        {/* Mobile backdrop */}
        {selected && (
          <div
            className="fixed inset-0 z-30 lg:hidden bg-black/50"
            onClick={() => setSelected(null)}
          />
        )}

        {/* Detail panel */}
        {selected && (
          <div className="absolute top-0 right-0 bottom-0 z-30">
            <div className="w-[380px] max-w-[100vw] h-full overflow-y-auto bg-[var(--bg)] flex flex-col shadow-[var(--shadow-overlay)]">
              {/* Close button */}
              <div className="sticky top-0 z-10 flex items-center justify-end px-[var(--space-4)] py-[var(--space-3)] bg-[var(--bg)]">
                <button
                  ref={closeRef}
                  onClick={() => setSelected(null)}
                  aria-label="Close detail panel"
                  className="w-[30px] h-[30px] rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-sm"
                >
                  &#x2715;
                </button>
              </div>

              {/* Employee detail */}
              <div className="px-[var(--space-4)] pb-[var(--space-6)]">
                <EmployeeDetail
                  name={selected.name}
                  prefetched={selected.rank === "executive" ? selected : undefined}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
