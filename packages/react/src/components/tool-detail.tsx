import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { toolSchemaAtom } from "../api/atoms";
import {
  ScopeId,
  ToolId,
  type EffectivePolicy,
  type ToolPolicyAction,
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
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { CopyButton } from "./copy-button";
import { ChevronRight, ChevronDownIcon } from "lucide-react";
import { cn } from "../lib/utils";
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
  toolId: string;
  toolName: string;
  scopeId: ScopeId;
  /** Resolved effective policy — user-authored or plugin-default,
   *  unified into one shape. Surfaces in the header. */
  policy?: EffectivePolicy;
  /** When provided, the policy badge becomes a dropdown trigger that
   *  applies a user rule to this tool's exact id. */
  onSetPolicy?: (pattern: string, action: ToolPolicyAction) => void;
  onClearPolicy?: (pattern: string) => void;
}) {
  const toolContract = useAtomValue(toolSchemaAtom(props.scopeId, props.toolId as ToolId));
  const [tab, setTab] = useState<"schema" | "typescript">("schema");

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
            <CopyButton value={props.toolId} label="Copy tool ID" />
            <PolicyBadgeMenu
              toolName={props.toolName}
              policy={props.policy}
              onSetPolicy={props.onSetPolicy}
              onClearPolicy={props.onClearPolicy}
            />
          </div>
          {data?.description && (
            <div className="mt-1.5 max-w-lg text-sm text-muted-foreground line-clamp-2">
              <Markdown>{data.description}</Markdown>
            </div>
          )}

          {/* Tabs */}
          <div className="mt-3 flex gap-4" role="tablist">
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "schema"}
              onClick={() => setTab("schema")}
              className={[
                "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                tab === "schema"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              Schema
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "typescript"}
              onClick={() => setTab("typescript")}
              className={[
                "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                tab === "typescript"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              TypeScript
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {AsyncResult.match(toolContract, {
          onInitial: () => <div className="p-5 text-sm text-muted-foreground">Loading…</div>,
          onFailure: () => <div className="p-5 text-sm text-destructive">Something went wrong</div>,
          onSuccess: () =>
            tab === "schema" ? (
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
        })}
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
  policy?: EffectivePolicy;
  onSetPolicy?: (pattern: string, action: ToolPolicyAction) => void;
  onClearPolicy?: (pattern: string) => void;
}) {
  const interactive = !!props.onSetPolicy;
  // The "Clear" affordance only makes sense when there's a user rule
  // pinned to this exact tool id — clearing a wildcard rule from a
  // single tool's detail header would silently affect siblings.
  const hasExactUserRule =
    props.policy?.source === "user" && props.policy.pattern === props.toolName;
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
        <DropdownMenuLabel className="font-mono text-xs">{props.toolName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {POLICY_ACTIONS_IN_ORDER.map((action) => (
          <DropdownMenuItem
            key={action}
            onSelect={() => props.onSetPolicy?.(props.toolName, action)}
          >
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
              onSelect={() => props.onClearPolicy?.(props.toolName)}
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
