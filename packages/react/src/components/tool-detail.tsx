import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { toolSchemaAtom } from "../api/atoms";
import {
  type ToolAddress,
  type EffectivePolicy,
  type ToolPolicyAction,
  type Connection,
  type ConnectionName,
  type IntegrationSlug,
} from "@executor-js/sdk/shared";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Markdown } from "./markdown";
import { SchemaExplorer } from "./schema-explorer";
import { ExpandableCodeBlock } from "./expandable-code-block";
import { ToolRunPanel } from "./tool-run-panel";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { CopyButton } from "./copy-button";
import { ChevronRight, ChevronDownIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { toPolicyPattern } from "../lib/policy-pattern";
import { trackEvent } from "../api/analytics";
import {
  POLICY_ACTION_LABEL,
  POLICY_ACTIONS_IN_ORDER,
  POLICY_BADGE_VARIANT,
  POLICY_STATE_LABEL,
} from "../lib/policy-display";

// Render the effective policy as a badge. User policies show the
// matched pattern; plugin defaults read "Default: <action>". Silent for
// the always-run plugin default — that's the safe state and the
// header would just be noise.
const policyBadgeFor = (policy: EffectivePolicy) => {
  if (policy.source === "plugin-default" && policy.action === "approve") {
    return null;
  }
  if (policy.source === "user") {
    return {
      variant: POLICY_BADGE_VARIANT[policy.action],
      title: `Matched policy: ${policy.pattern}`,
      text: `${POLICY_STATE_LABEL[policy.action]} · ${policy.pattern}`,
      className: "font-mono text-[10px]",
    };
  }
  return {
    variant: "outline" as const,
    title: "No matching policy — plugin default applies",
    text: `Default: ${POLICY_STATE_LABEL[policy.action]}`,
    className: "text-[10px] text-muted-foreground",
  };
};

function EmptySection(props: { title: string; message: string }) {
  return (
    <CardStack>
      <CardStackHeader>{props.title}</CardStackHeader>
      <CardStackContent>
        <p className="px-4 py-3 text-sm text-muted-foreground">{props.message}</p>
      </CardStackContent>
    </CardStack>
  );
}

function ToolDescription(props: { description: string }) {
  const { description } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(
    description.length > 160 || description.includes("\n"),
  );

  useEffect(() => {
    setExpanded(false);
    setCanExpand(description.length > 160 || description.includes("\n"));
  }, [description]);

  useEffect(() => {
    if (expanded) return;

    const element = contentRef.current;
    if (!element) return;

    const measure = () => {
      setCanExpand(
        element.scrollHeight > element.clientHeight + 1 ||
          description.length > 160 ||
          description.includes("\n"),
      );
    };

    measure();
    const win = element.ownerDocument.defaultView;
    win?.addEventListener("resize", measure);
    return () => win?.removeEventListener("resize", measure);
  }, [description, expanded]);

  return (
    <div className="mt-1.5 max-w-2xl">
      <div
        ref={contentRef}
        className={cn("text-sm text-muted-foreground", !expanded && "line-clamp-2")}
      >
        <Markdown>{description}</Markdown>
      </div>
      {canExpand && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          className="mt-1 h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const friendlyName = (name: string): string => {
  const leaf = name.split(".").pop() ?? name;
  return leaf
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const breadcrumbParts = (name: string): string[] =>
  name.split(".").map((p) =>
    p
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  );

// ---------------------------------------------------------------------------
// ToolDetail
// ---------------------------------------------------------------------------

export function ToolDetail(props: {
  /** Full per-connection tool address `tools.<int>.<owner>.<conn>.<tool>`. */
  address: ToolAddress;
  /** Policy id `<integration>.<tool>` — the tree path and display value. */
  toolName: string;
  /** True for plugin-contributed static tools (policy-matched on their
   *  address verbatim, not the connection-wildcarded pattern). */
  staticTool?: boolean;
  /** Resolved effective policy — user-authored or plugin-default,
   *  unified into one shape. Surfaces in the header. */
  policy?: EffectivePolicy;
  /** When provided, the policy badge becomes a dropdown trigger that
   *  applies a user rule to this tool's exact id. */
  onSetPolicy?: (pattern: string, action: ToolPolicyAction) => void;
  onClearPolicy?: (pattern: string) => void;
  patternForDisplay?: (displayPattern: string) => string;
  /** Run-tab wiring. When `integration` + `runToolName` are provided, a third
   *  "Run" tab hosts the per-connection tool tester. */
  integration?: IntegrationSlug;
  /** Bare `<tool>` address segment (may contain dots) for the Run tab. */
  runToolName?: string;
  /** This integration's connections across both owners. */
  connections?: readonly Connection[];
  /** Pre-select this connection in the Run tab (the selected tool's account). */
  initialConnectionName?: ConnectionName | string | null;
}) {
  const toolContract = useAtomValue(toolSchemaAtom(props.address));
  const [tab, setTab] = useState<"schema" | "typescript" | "run">("schema");
  const canRun = props.integration != null && props.runToolName != null;
  // Don't strand the user on the Run tab when this ToolDetail has no run wiring.
  const activeTab = tab === "run" && !canRun ? "schema" : tab;
  const isBlocked = props.policy?.action === "block";

  const data = useMemo(() => {
    if (!AsyncResult.isSuccess(toolContract)) return null;
    const v = toolContract.value;
    const definitions = Object.entries(v.typeScriptDefinitions ?? {}).map(([name, body]) => ({
      name,
      code: String(body),
    }));

    return {
      description: v.description,
      inputSchema: v.inputSchema,
      outputSchema: v.outputSchema,
      schemaDefinitions: v.schemaDefinitions,
      inputTypeScript: v.inputTypeScript ? `type Input = ${v.inputTypeScript}` : null,
      outputTypeScript: v.outputTypeScript ? `type Output = ${v.outputTypeScript}` : null,
      definitions,
    };
  }, [toolContract]);

  const crumbs = breadcrumbParts(props.toolName);
  const displayName = friendlyName(props.toolName);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header + tabs */}
      <div className="shrink-0 border-b border-border/40">
        <div className="px-5 pt-4 pb-0">
          {crumbs.length > 1 && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              {crumbs.slice(0, -1).map((part, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 shrink-0" />}
                  <span>{part}</span>
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground truncate">{displayName}</h3>
            <CopyButton
              value={String(props.address)}
              label="Copy tool ID"
              onCopy={() => {
                const nameParts = props.toolName.split(".");
                trackEvent("tool_id_copied", {
                  integration_slug: nameParts[0] ?? props.toolName,
                  tool_name: nameParts.slice(1).join(".") || props.toolName,
                });
              }}
            />
            <PolicyBadgeMenu
              toolName={props.toolName}
              staticTool={props.staticTool}
              policy={props.policy}
              onSetPolicy={props.onSetPolicy}
              onClearPolicy={props.onClearPolicy}
              patternForDisplay={props.patternForDisplay}
            />
          </div>
          {data?.description && <ToolDescription description={data.description} />}

          {/* Tabs */}
          <div className="mt-3 flex gap-4" role="tablist">
            <Button
              variant="ghost"
              role="tab"
              aria-selected={activeTab === "schema"}
              onClick={() => setTab("schema")}
              className={[
                "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                activeTab === "schema"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              Schema
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={activeTab === "typescript"}
              onClick={() => setTab("typescript")}
              className={[
                "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                activeTab === "typescript"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              TypeScript
            </Button>
            {canRun && (
              <Button
                variant="ghost"
                role="tab"
                aria-selected={activeTab === "run"}
                onClick={() => setTab("run")}
                className={[
                  "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                  activeTab === "run"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                Run
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isBlocked ? (
          <div className="px-5 py-5">
            <EmptySection
              title="Blocked"
              message="This tool is not available through the current toolkit."
            />
          </div>
        ) : (
          AsyncResult.match(toolContract, {
            onInitial: () => <div className="p-5 text-sm text-muted-foreground">Loading…</div>,
            onFailure: () => (
              <div className="p-5 text-sm text-destructive">Something went wrong</div>
            ),
            onSuccess: () =>
              activeTab === "run" && props.integration && props.runToolName ? (
                <div className="px-5 py-5">
                  <ToolRunPanel
                    integration={props.integration}
                    toolName={props.runToolName}
                    connections={props.connections ?? []}
                    initialConnectionName={props.initialConnectionName}
                  />
                </div>
              ) : activeTab === "schema" ? (
                <div className="px-5 py-5 space-y-5">
                  {data?.inputSchema ? (
                    <SchemaExplorer
                      schema={data.inputSchema}
                      schemaDefinitions={data.schemaDefinitions}
                      title="Parameters"
                    />
                  ) : (
                    <EmptySection title="Parameters" message="None" />
                  )}
                  {data?.outputSchema ? (
                    <SchemaExplorer
                      schema={data.outputSchema}
                      schemaDefinitions={data.schemaDefinitions}
                      title="Response"
                    />
                  ) : (
                    <EmptySection title="Response" message="None" />
                  )}
                </div>
              ) : (
                <ToolTypeScriptPanel
                  inputTypeScript={data?.inputTypeScript ?? null}
                  outputTypeScript={data?.outputTypeScript ?? null}
                  definitions={data?.definitions ?? []}
                />
              ),
          })
        )}
      </div>
    </div>
  );
}

function ToolTypeScriptPanel(props: {
  inputTypeScript: string | null;
  outputTypeScript: string | null;
  definitions: ReadonlyArray<{ name: string; code: string }>;
}) {
  return (
    <div className="px-5 py-5 space-y-5">
      {props.inputTypeScript ? (
        <CardStack>
          <CardStackHeader>Input</CardStackHeader>
          <CardStackContent>
            <ExpandableCodeBlock
              code={props.inputTypeScript}
              definitions={props.definitions}
              className="rounded-none border-0"
            />
          </CardStackContent>
        </CardStack>
      ) : (
        <EmptySection title="Input" message="void" />
      )}
      {props.outputTypeScript ? (
        <CardStack>
          <CardStackHeader>Output</CardStackHeader>
          <CardStackContent>
            <ExpandableCodeBlock
              code={props.outputTypeScript}
              definitions={props.definitions}
              className="rounded-none border-0"
            />
          </CardStackContent>
        </CardStack>
      ) : (
        <EmptySection title="Output" message="void" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PolicyBadgeMenu — clickable header badge that opens the same
// Always run / Require approval / Block / Clear menu the tree row uses.
// Falls back to a plain Badge when no actions are provided.
// ---------------------------------------------------------------------------

function PolicyBadgeMenu(props: {
  toolName: string;
  /** Static (plugin-contributed) tools are policy-matched on their full
   *  address verbatim; dynamic tools on the connection-wildcarded form. */
  staticTool?: boolean;
  policy?: EffectivePolicy;
  onSetPolicy?: (pattern: string, action: ToolPolicyAction) => void;
  onClearPolicy?: (pattern: string) => void;
  patternForDisplay?: (displayPattern: string) => string;
}) {
  const interactive = !!props.onSetPolicy;
  // The same pattern bridge the tree rows apply — the pattern WRITTEN and the
  // pattern LOOKED UP must be the same string, or the menu authors rules that
  // never match and can't see its own rule afterward.
  const pattern = props.staticTool
    ? props.toolName
    : (props.patternForDisplay ?? toPolicyPattern)(props.toolName);
  // The "Clear" affordance only makes sense when there's a user rule
  // pinned to this exact tool id — clearing a wildcard rule from a
  // single tool's detail header would silently affect siblings.
  const hasExactUserRule = props.policy?.source === "user" && props.policy.pattern === pattern;
  const currentAction = hasExactUserRule ? props.policy?.action : undefined;

  if (!interactive) {
    if (!props.policy) return null;
    const badge = policyBadgeFor(props.policy);
    if (!badge) return null;
    return (
      <Badge variant={badge.variant} title={badge.title} className={badge.className}>
        {badge.text}
      </Badge>
    );
  }

  // Interactive trigger always renders, even when the effective policy
  // would otherwise be "silent" (auto-approve plugin-default), so the
  // user can click it to override.
  const badge = props.policy ? policyBadgeFor(props.policy) : null;
  const triggerLabel = badge?.text ?? "Set policy";
  const triggerVariant = badge?.variant ?? "outline";
  const triggerTitle = badge?.title ?? "Set policy";
  const triggerClassName = badge?.className ?? "text-[10px] text-muted-foreground";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={triggerTitle}
          className="h-auto rounded-none p-0 hover:bg-transparent"
        >
          <Badge
            variant={triggerVariant}
            title={triggerTitle}
            className={cn(
              triggerClassName,
              "cursor-pointer gap-1 pr-1.5 transition-opacity hover:opacity-80",
            )}
          >
            {triggerLabel}
            <ChevronDownIcon aria-hidden className="size-3 opacity-70" />
          </Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="font-mono text-xs">{pattern}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {POLICY_ACTIONS_IN_ORDER.map((action) => (
          <DropdownMenuItem key={action} onSelect={() => props.onSetPolicy?.(pattern, action)}>
            <span className="flex-1">{POLICY_ACTION_LABEL[action]}</span>
            {currentAction === action && (
              <span aria-hidden className="text-muted-foreground">
                ✓
              </span>
            )}
          </DropdownMenuItem>
        ))}
        {hasExactUserRule && props.onClearPolicy && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => props.onClearPolicy?.(pattern)}
              className="text-muted-foreground"
            >
              Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function ToolDetailEmpty(props: { hasTools: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">
          {props.hasTools ? "Select a tool" : "No tools available"}
        </p>
        {props.hasTools && (
          <p className="mt-1.5 text-sm text-muted-foreground">
            Choose from the list to see what it does.
          </p>
        )}
      </div>
    </div>
  );
}
