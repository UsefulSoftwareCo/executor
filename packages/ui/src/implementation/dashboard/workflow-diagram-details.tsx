import { HugeiconsIcon } from "@hugeicons/react";
import {
  GitForkIcon,
  LayoutTwoColumnIcon,
  PlayCircleIcon,
  RepeatIcon,
  Shield01Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import type { App, SourceFile } from "@executor-js/sdk";
import type {
  Reference,
  WorkflowGraph,
  WorkflowNode,
} from "@executor-js/workflow-graph/contracts/graph";
import type { ComponentProps, ReactNode } from "react";
import { Code } from "./code.tsx";
import { useDashboard } from "./context.tsx";
import { boxTitle, StepName, StepTile, stepKind } from "./workflow-diagram-cards.tsx";
import {
  ReferenceRow,
  Row,
  StarterRow,
  UseReference,
  UseRow,
} from "./workflow-diagram-references.tsx";

/** What the selected card is, what it uses and the code it came from. */

const MAX_EXCERPT = 16;
/** The start card shows the declaration through the options and handler signature. */
const START_EXCERPT = 4;

type IconSvgElement = ComponentProps<typeof HugeiconsIcon>["icon"];

export function WorkflowDetails({
  app,
  graph,
  node,
  files,
  onOpenWorkflow,
  onShowWorkflow,
}: {
  readonly app: App;
  readonly graph: WorkflowGraph;
  /** `undefined` for the start card. */
  readonly node: WorkflowNode | undefined;
  readonly files: ReadonlyArray<SourceFile>;
  readonly onOpenWorkflow: (name: string, step: string) => void;
  readonly onShowWorkflow: (name: string) => void;
}) {
  if (node === undefined)
    return <StartDetails app={app} graph={graph} files={files} onShowWorkflow={onShowWorkflow} />;
  const excerpt = (from: number, to = from) => (
    <Excerpt app={app} files={files} file={node.file} from={from} to={to} />
  );
  switch (node.type) {
    case "step": {
      const workflows = node.uses.filter((use) => use.kind === "workflow");
      return (
        <Panel
          tile={<StepTile app={app} node={node} />}
          kind={stepKind(node)}
          title={<StepName node={node} />}
        >
          <dl className="mb-3.5 grid grid-cols-[82px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[12.5px]">
            {node.uses.map((use) => (
              <UseRow key={JSON.stringify(use)} app={app} use={use} />
            ))}
            {node.detail.map((item) => (
              <Row key={item.name} name={item.name}>
                {item.value}
              </Row>
            ))}
          </dl>
          {workflows.length > 0 && (
            <Section title="Starts">
              {workflows.map(
                (use) =>
                  use.kind === "workflow" && (
                    <ReferenceRow
                      key={use.name}
                      icon={WorkflowSquare01Icon}
                      title={use.name}
                      subtitle="Workflow"
                      onClick={() => onOpenWorkflow(use.name, node.label.text)}
                    />
                  ),
              )}
            </Section>
          )}
          {excerpt(node.line, node.end)}
        </Panel>
      );
    }
    case "branch":
      return (
        <Panel
          tile={
            <span className="mx-1 flex size-6.5 shrink-0 rotate-45 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <HugeiconsIcon
                icon={GitForkIcon}
                size={13}
                strokeWidth={2}
                className="-rotate-45"
                aria-hidden
              />
            </span>
          }
          kind="Decision"
          title={<span className="font-mono text-[13px] tracking-normal">{node.label.text}</span>}
        >
          <dl className="mb-3.5 grid grid-cols-[82px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[12.5px]">
            <Row name="Options">{node.arms.map((arm) => arm.label).join(", ")}</Row>
          </dl>
          {excerpt(node.line)}
        </Panel>
      );
    case "loop":
    case "parallel":
    case "try":
      return (
        <Panel
          tile={
            <IconTile
              icon={
                node.type === "loop"
                  ? RepeatIcon
                  : node.type === "parallel"
                    ? LayoutTwoColumnIcon
                    : Shield01Icon
              }
            />
          }
          kind={
            node.type === "loop"
              ? "Loop"
              : node.type === "parallel"
                ? "Parallel"
                : "Failure handling"
          }
          title={boxTitle(node)}
        >
          {node.type === "loop" && node.detail && (
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">{node.detail}</p>
          )}
          {excerpt(node.line)}
        </Panel>
      );
    case "end":
      return null;
  }
}

function StartDetails({
  app,
  graph,
  files,
  onShowWorkflow,
}: {
  readonly app: App;
  readonly graph: WorkflowGraph;
  readonly files: ReadonlyArray<SourceFile>;
  readonly onShowWorkflow: (name: string) => void;
}) {
  const uses = new Map<string, Reference>();
  const collect = (nodes: ReadonlyArray<WorkflowNode>) => {
    for (const node of nodes) {
      if (node.type === "step")
        for (const use of node.uses)
          if (use.kind === "account" || use.kind === "host") uses.set(JSON.stringify(use), use);
      if (node.type === "branch") for (const arm of node.arms) collect(arm.body);
      if (node.type === "loop") collect(node.body);
      if (node.type === "parallel") for (const branch of node.branches) collect(branch);
      if (node.type === "try") {
        collect(node.body);
        collect(node.failure);
        collect(node.cleanup);
      }
    }
  };
  collect(graph.nodes);
  return (
    <Panel
      tile={
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-primary text-primary-foreground">
          <HugeiconsIcon icon={PlayCircleIcon} size={17} strokeWidth={1.7} aria-hidden />
        </span>
      }
      kind="Start"
      title={graph.name}
    >
      {graph.input.length > 0 && (
        <dl className="mb-3.5 grid grid-cols-[82px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[12.5px]">
          <Row name="Input">
            <span className="font-mono text-[11.5px]">{graph.input.join(", ")}</span>
          </Row>
        </dl>
      )}
      <Section title="Started by">
        {graph.startedBy.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            Nothing in the app’s code starts it. Start it here or through the API.
          </p>
        ) : (
          graph.startedBy.map((starter) => (
            <StarterRow
              key={JSON.stringify(starter)}
              app={app}
              starter={starter}
              onShowWorkflow={onShowWorkflow}
            />
          ))
        )}
      </Section>
      {uses.size > 0 && (
        <Section title="Uses">
          {[...uses.values()].map((use) => (
            <UseReference key={JSON.stringify(use)} app={app} use={use} />
          ))}
        </Section>
      )}
      <Excerpt
        app={app}
        files={files}
        file={graph.file}
        from={graph.line}
        to={graph.line + START_EXCERPT - 1}
      />
    </Panel>
  );
}

function Panel({
  tile,
  kind,
  title,
  children,
}: {
  readonly tile: ReactNode;
  readonly kind: ReactNode;
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <aside
      aria-label="Workflow diagram details"
      className="min-w-0 border-t p-4 @[760px]:border-t-0 @[760px]:border-l"
    >
      <div className="mb-3.5 flex items-center gap-3 [&_.provider-icon]:size-8">
        {tile}
        <div className="min-w-0">
          <div className="truncate text-[11px] text-muted-foreground">{kind}</div>
          <div className="truncate text-sm font-semibold tracking-tight">{title}</div>
        </div>
      </div>
      {children}
    </aside>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="mb-2 text-[11.5px] font-medium text-muted-foreground">{title}</h4>
      <div className="grid gap-1.5">{children}</div>
    </section>
  );
}

function IconTile({ icon }: { readonly icon: IconSvgElement }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-accent text-foreground/80">
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.7} aria-hidden />
    </span>
  );
}

/** The lines a card was drawn from. */
function Excerpt({
  app,
  files,
  file,
  from,
  to,
}: {
  readonly app: App;
  readonly files: ReadonlyArray<SourceFile>;
  readonly file: string;
  readonly from: number;
  readonly to: number;
}) {
  const { AppLink } = useDashboard();
  const source = files.find((entry) => entry.path === file);
  if (!source || "encoding" in source || !("content" in source)) return null;
  const last = Math.min(to, from + MAX_EXCERPT - 1);
  const lines = source.content.split("\n").slice(from - 1, last);
  // A call nested in loops starts deep in; the excerpt reads better without the shared indent.
  const indent = Math.min(
    ...lines
      .filter((text) => text.trim() !== "")
      .map((text) => /^\s*/u.exec(text)?.[0].length ?? 0),
  );
  const code = lines.map((text) => text.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
  return (
    <section className="mt-1">
      <h4 className="mb-2 text-[11.5px] font-medium text-muted-foreground">Code</h4>
      <div className="max-h-72 overflow-hidden rounded-md border [&_.code-view]:max-h-72">
        <Code code={code} path={file} lineNumbers={false} />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 text-[11.5px] text-muted-foreground">
        <span className="truncate">
          {file} · {last > from ? `lines ${from}–${last}` : `line ${from}`}
        </span>
        <AppLink
          app={app.id}
          view="source"
          className="shrink-0 font-medium text-foreground hover:underline"
        >
          Open in Source →
        </AppLink>
      </div>
    </section>
  );
}
