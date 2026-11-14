import { HugeiconsIcon } from "@hugeicons/react";
import {
  CodeIcon,
  LayoutTwoColumnIcon,
  DatabaseAddIcon,
  DatabaseIcon,
  GitForkIcon,
  HourglassIcon,
  PlayCircleIcon,
  RepeatIcon,
  Shield01Icon,
  Timer01Icon,
  WorkflowSquare01Icon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import type { App } from "@executor-js/sdk";
import type { StepNode, WorkflowNode } from "@executor-js/workflow-graph/contracts/graph";
import type { LayoutBox, LayoutCard } from "@executor-js/workflow-graph/layout";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { ProviderIcon } from "./common.tsx";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";

/** The cards and boxes a workflow is drawn with, and the words and tiles they share with the details panel. */

const frame =
  "absolute z-[2] flex cursor-pointer items-center gap-3 border bg-background px-3 text-left shadow-[0_1px_2px_#0000000a] outline-none transition-[border-color,box-shadow] duration-150 hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring";
const selectedFrame =
  "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_10%,transparent)] hover:border-primary";

const END_LABEL = {
  done: "Done",
  fails: "Fails",
  next: "Next",
  exit: "Exit loop",
  return: "Returns",
} as const;

export function Card({
  app,
  card,
  input,
  selected,
  onSelect,
  onOpenWorkflow,
}: {
  readonly app: App;
  readonly card: LayoutCard;
  readonly input: ReadonlyArray<string>;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  readonly onOpenWorkflow: (name: string, step: string) => void;
}) {
  const style = { left: card.x, top: card.y, width: card.width, height: card.height };
  if (card.kind === "start")
    return (
      <button
        type="button"
        data-workflow-node="start"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(card.id)}
        className={cn(frame, "rounded-[10px]", selected && selectedFrame)}
        style={style}
      >
        <span className="flex size-8.5 shrink-0 items-center justify-center rounded-[8px] bg-primary text-primary-foreground">
          <HugeiconsIcon icon={PlayCircleIcon} size={17} strokeWidth={1.7} aria-hidden />
        </span>
        <CardText
          kind={input.length > 0 ? "Starts with" : "Start"}
          label={input.length > 0 ? input.join(", ") : "No input"}
        />
      </button>
    );
  const node = card.node;
  if (node.type === "end")
    return (
      <span
        data-workflow-node="end"
        className={cn(
          "absolute z-[2] flex items-center justify-center rounded-full border bg-accent text-[11px] font-medium text-muted-foreground",
          node.outcome === "fails" && "text-destructive",
        )}
        style={style}
      >
        {END_LABEL[node.outcome]}
      </span>
    );
  if (node.type === "branch")
    return (
      <button
        type="button"
        data-workflow-node="decision"
        title={node.label.text}
        aria-current={selected ? "true" : undefined}
        aria-label={`Decision: ${node.label.text}`}
        onClick={() => onSelect(card.id)}
        className={cn(frame, "rounded-full pr-5", selected && selectedFrame)}
        style={style}
      >
        {/* The diamond is what tells a decision from a step at a glance. */}
        <span className="mx-0.5 flex size-6.5 shrink-0 rotate-45 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <HugeiconsIcon
            icon={GitForkIcon}
            size={13}
            strokeWidth={2}
            className="-rotate-45"
            aria-hidden
          />
        </span>
        <CardText kind="Decision" label={node.label.text} mono />
      </button>
    );
  if (node.type !== "step") return null;
  const workflow = node.uses.find((use) => use.kind === "workflow");
  return (
    <>
      <button
        type="button"
        data-workflow-node="step"
        title={node.label.text}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(card.id)}
        className={cn(frame, "rounded-[10px]", selected && selectedFrame)}
        style={style}
      >
        <StepTile app={app} node={node} />
        <CardText kind={stepKind(node)} label={<StepName node={node} />} />
      </button>
      {workflow?.kind === "workflow" && (
        <button
          type="button"
          aria-label={`Open ${workflow.name}`}
          onClick={() => onOpenWorkflow(workflow.name, node.label.text)}
          className="absolute z-[3] inline-flex h-6 -translate-x-full items-center gap-1 rounded-full border border-input bg-background px-2 text-[11px] font-medium outline-none hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
          style={{ left: card.x + card.width - 12, top: card.y + card.height - 12 }}
        >
          <HugeiconsIcon icon={WorkflowSquare01Icon} size={11} strokeWidth={2} aria-hidden />
          {workflow.name}
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={2} aria-hidden />
        </button>
      )}
    </>
  );
}

function CardText({
  kind,
  label,
  mono = false,
}: {
  readonly kind: ReactNode;
  readonly label: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="truncate text-[11px] text-muted-foreground">{kind}</span>
      <span
        className={cn(
          "truncate text-[13.5px] font-medium",
          mono && "font-mono text-[12.5px] tracking-normal",
        )}
      >
        {label}
      </span>
    </span>
  );
}

export function StepName({ node }: { readonly node: StepNode }) {
  if (!node.label.dynamic) return node.label.text;
  // Templates show `…` for each dynamic part; it reads as a placeholder, not as text.
  return node.label.text.split("…").map((part, index, parts) => (
    // The parts of one label never reorder.
    <span key={index}>
      {part}
      {index < parts.length - 1 && <span className="font-normal text-muted-foreground">…</span>}
    </span>
  ));
}

export function stepKind(node: StepNode): ReactNode {
  const tool = node.uses.find((use) => use.kind === "tool");
  const host = node.uses.find((use) => use.kind === "host");
  switch (node.kind) {
    case "query":
      return tool?.kind === "tool" ? (
        <>
          Query · <span className="font-mono text-[10.5px] text-foreground">{tool.path}</span>
        </>
      ) : (
        "Query"
      );
    case "mutation":
      return tool?.kind === "tool" ? (
        <>
          Mutation · <span className="font-mono text-[10.5px] text-foreground">{tool.path}</span>
        </>
      ) : (
        "Mutation"
      );
    case "sleep":
      return "Wait";
    case "sleepUntil":
      return "Wait until";
    case "do":
      return host?.kind === "host" ? `Step · ${host.host}` : "Step";
  }
}

const KIND_ICON = {
  do: CodeIcon,
  query: DatabaseIcon,
  mutation: DatabaseAddIcon,
  sleep: Timer01Icon,
  sleepUntil: HourglassIcon,
} as const;

/** The square at the start of a step: the account's provider, else the host's logo, else the step's kind. */
export function StepTile({ app, node }: { readonly app: App; readonly node: StepNode }) {
  const account = node.uses.find((use) => use.kind === "account");
  const provider =
    account?.kind === "account" ? app.requirements.accounts[account.slot]?.definition : undefined;
  if (provider) return <ProviderIcon name={provider.name} url={providerDisplayUrl(provider)} />;
  const host = node.uses.find((use) => use.kind === "host");
  if (host?.kind === "host" && declaresHost(app, host.host))
    return <ProviderIcon name={host.host} url={host.host} />;
  return (
    <span className="flex size-8.5 shrink-0 items-center justify-center rounded-[8px] bg-accent text-foreground/80">
      <HugeiconsIcon icon={KIND_ICON[node.kind]} size={17} strokeWidth={1.7} aria-hidden />
    </span>
  );
}

const BOX_ICON = { loop: RepeatIcon, parallel: LayoutTwoColumnIcon, try: Shield01Icon } as const;

export function Box({
  box,
  selected,
  onSelect,
}: {
  readonly box: LayoutBox;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const node = box.node;
  if (node.type !== "loop" && node.type !== "parallel" && node.type !== "try") return null;
  return (
    <div
      className={cn(
        "absolute z-0 rounded-[14px] border bg-background/55 transition-[border-color] duration-150",
        selected ? "border-primary/60" : "border-input/70",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <button
        type="button"
        data-workflow-node={node.type}
        title={
          node.type === "loop" && node.detail
            ? `${boxTitle(node)} · ${node.detail}`
            : boxTitle(node)
        }
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(box.id)}
        className="flex h-8.5 w-full cursor-pointer items-center gap-1.5 rounded-t-[14px] px-3 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <HugeiconsIcon
          icon={BOX_ICON[node.type]}
          size={14}
          strokeWidth={1.7}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="truncate font-medium">{boxTitle(node)}</span>
        {node.type === "loop" && node.detail && (
          <span className="truncate text-muted-foreground">· {node.detail}</span>
        )}
      </button>
    </div>
  );
}

export function boxTitle(node: WorkflowNode): string {
  if (node.type === "loop") return node.label.text;
  if (node.type === "parallel") return "At the same time";
  return "Try";
}

/**
 * Logos come from a third-party icon service. Only hosts of providers the app declares are looked
 * up there, so a private hostname in an app's code is never sent anywhere by drawing it.
 */
export function declaresHost(app: App, host: string): boolean {
  const site = (name: string) => name.split(".").slice(-2).join(".");
  return Object.values(app.requirements.accounts).some((slot) => {
    const url = providerDisplayUrl(slot.definition);
    return url !== null && URL.canParse(url) && site(new URL(url).hostname) === site(host);
  });
}
