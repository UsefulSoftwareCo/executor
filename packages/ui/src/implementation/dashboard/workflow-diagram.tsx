import type { App, Version } from "@executor-js/sdk";
import type { WorkflowNode } from "@executor-js/workflow-graph/contracts/graph";
import { deriveAppGraph } from "@executor-js/workflow-graph/derive";
import { layoutWorkflow } from "@executor-js/workflow-graph/layout";
import { Fragment, useMemo, useState } from "react";
import { WorkflowCanvas } from "./workflow-diagram-canvas.tsx";
import { WorkflowDetails } from "./workflow-diagram-details.tsx";

/**
 * The selected workflow drawn from the deployed version's own source, above its run history.
 * Reaching another workflow through a step or a "Started by" entry adds to the breadcrumb trail.
 * Loaded on demand, so the parser stays out of every other dashboard page. It stays mounted while
 * the person moves between workflows, so the source is parsed once per version.
 */

/** A workflow on the way here, and the step that led on when one did. */
export interface Crumb {
  readonly workflow: string;
  readonly step?: string;
}

export default function WorkflowDiagram({
  app,
  version,
  workflow,
  trail,
  onOpenWorkflow,
  onShowWorkflow,
  onCrumb,
}: {
  readonly app: App;
  readonly version: Version;
  readonly workflow: string;
  readonly trail: ReadonlyArray<Crumb>;
  readonly onOpenWorkflow: (name: string, step: string) => void;
  readonly onShowWorkflow: (name: string) => void;
  readonly onCrumb: (index: number) => void;
}) {
  const graphs = useMemo(() => deriveAppGraph(version.files), [version.files]);
  const graph = graphs.workflows.find((item) => item.name === workflow);
  const layout = useMemo(() => (graph ? layoutWorkflow(graph) : undefined), [graph]);
  // A selection belongs to the workflow it was made in; another workflow opens at its start.
  const [selection, setSelection] = useState({ workflow, id: "start" });
  const selected = selection.workflow === workflow ? selection.id : "start";
  const node = useMemo(
    () => (graph ? findNode(graph.nodes, selected) : undefined),
    [graph, selected],
  );
  return (
    <>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3.5 py-2 text-[13px]">
        <nav aria-label="Workflow trail" className="flex min-w-0 flex-wrap items-center gap-1.5">
          {trail.map((crumb, index) => (
            <Fragment key={`${crumb.workflow}:${index}`}>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onCrumb(index)}
              >
                {crumb.workflow}
              </button>
              <span className="text-muted-foreground/60" aria-hidden>
                ›
              </span>
              {crumb.step !== undefined && (
                <>
                  <span className="text-muted-foreground">{crumb.step}</span>
                  <span className="text-muted-foreground/60" aria-hidden>
                    ›
                  </span>
                </>
              )}
            </Fragment>
          ))}
          <span className="font-medium" aria-current="page">
            {workflow}
          </span>
        </nav>
        {graph && (
          <span className="text-xs text-muted-foreground">
            from <span className="font-mono text-[11.5px] text-foreground">{graph.file}</span>
          </span>
        )}
        {graph?.partial && (
          <span className="text-xs text-muted-foreground">
            · Only part of this workflow is drawn; the rest is too large or repeats itself
          </span>
        )}
      </div>
      {graph && layout ? (
        <div className="grid grid-cols-1 @[760px]:grid-cols-[minmax(0,1fr)_320px]">
          <WorkflowCanvas
            app={app}
            layout={layout}
            input={graph.input}
            selected={selected}
            onSelect={(id) => setSelection({ workflow, id })}
            onOpenWorkflow={onOpenWorkflow}
          />
          <WorkflowDetails
            app={app}
            graph={graph}
            node={node}
            files={version.files}
            onOpenWorkflow={onOpenWorkflow}
            onShowWorkflow={onShowWorkflow}
          />
        </div>
      ) : (
        <p className="px-4 py-5 text-sm text-muted-foreground">
          This workflow isn’t declared in the app’s{" "}
          <code className="font-mono text-xs">defineApp</code> in a way the diagram can read, so it
          can’t be drawn.
        </p>
      )}
    </>
  );
}

function findNode(nodes: ReadonlyArray<WorkflowNode>, id: string): WorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner =
      node.type === "branch"
        ? node.arms.flatMap((arm) => arm.body)
        : node.type === "loop"
          ? node.body
          : node.type === "parallel"
            ? node.branches.flat()
            : node.type === "try"
              ? [...node.body, ...node.failure, ...node.cleanup]
              : [];
    const found = findNode(inner, id);
    if (found) return found;
  }
  return undefined;
}
