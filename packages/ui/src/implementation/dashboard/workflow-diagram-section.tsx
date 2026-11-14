import type { App, Version } from "@executor-js/sdk";
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { WorkflowDiagramLoading } from "./app-browser-loading.tsx";
import { useHydrated } from "../hooks/hydrated.ts";
import { QueryView } from "./context.tsx";
import type { Crumb } from "./workflow-diagram.tsx";

/**
 * The diagram above a workflow's runs. Its code, and the parser in it, load on demand in a browser
 * after hydration, so a server build drops the import: every module a Worker uploads is compiled
 * whenever one of its isolates starts. A failed load or a source the diagram trips on stays inside
 * this frame, so the run history never goes with it.
 */

/** Starts loading the diagram's code. The module system keeps the loaded module for later calls. */
export const preloadWorkflowDiagram = () =>
  import.meta.env.SSR
    ? Promise.reject(new Error("The workflow diagram renders only in a browser"))
    : import("./workflow-diagram.tsx");

export function WorkflowDiagramSection<E>({
  app,
  source,
  workflow,
  trail,
  onOpenWorkflow,
  onShowWorkflow,
  onCrumb,
  Failure,
}: {
  readonly app: App;
  readonly source: Query<Version, E>;
  readonly workflow: string;
  readonly trail: ReadonlyArray<Crumb>;
  readonly onOpenWorkflow: (name: string, step: string) => void;
  readonly onShowWorkflow: (name: string) => void;
  readonly onCrumb: (index: number) => void;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const hydrated = useHydrated();
  // A new lazy component per attempt: React keeps a failed lazy load and would not ask again.
  const [attempt, setAttempt] = useState(0);
  const [Diagram, setDiagram] = useState(() => lazy(preloadWorkflowDiagram));
  return (
    <div
      role="group"
      aria-label="Workflow diagram"
      className="@container mb-7 overflow-hidden rounded-lg border"
    >
      {!hydrated ? (
        <WorkflowDiagramLoading />
      ) : (
        <QueryView query={source} Failure={Failure} pending={<WorkflowDiagramLoading />}>
          {(version) => (
            <DiagramBoundary
              key={attempt}
              retry={() => {
                setDiagram(() => lazy(preloadWorkflowDiagram));
                setAttempt(attempt + 1);
              }}
            >
              <Suspense fallback={<WorkflowDiagramLoading />}>
                <Diagram
                  app={app}
                  version={version}
                  workflow={workflow}
                  trail={trail}
                  onOpenWorkflow={onOpenWorkflow}
                  onShowWorkflow={onShowWorkflow}
                  onCrumb={onCrumb}
                />
              </Suspense>
            </DiagramBoundary>
          )}
        </QueryView>
      )}
    </div>
  );
}

class DiagramBoundary extends Component<
  { readonly retry: () => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 text-sm text-muted-foreground">
        <span>This workflow’s diagram couldn’t be drawn. Its runs below are unaffected.</span>
        <Button variant="outline" size="sm" onClick={this.props.retry}>
          Try again
        </Button>
      </div>
    );
  }
}
