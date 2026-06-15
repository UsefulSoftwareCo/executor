// ---------------------------------------------------------------------------
// @executor-js/plugin-toolkits/react — the Toolkits console page.
//
// A toolkit is a named slice of the caller's connections (each off/read/full)
// with its own MCP endpoint; an agent connected to one can't see anything
// outside it. This is a SINGLE page (the plugin route matcher is exact-path,
// no params) that switches between the list and a per-toolkit editor via local
// state — the same shape as the design prototype.
//
// Workspace toolkits draw on org-owned connections; personal toolkits can use
// org + the caller's own. The list query returns every visible toolkit and we
// split by `scope`.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import {
  connectionsAllAtom,
  integrationsAtom,
} from "@executor-js/react/api/atoms";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Textarea } from "@executor-js/react/components/textarea";
import { Switch } from "@executor-js/react/components/switch";
import { Label } from "@executor-js/react/components/label";
import { Badge } from "@executor-js/react/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/react/components/select";
import { IntegrationFavicon } from "@executor-js/react/components/integration-favicon";
import { copyToClipboard } from "@executor-js/react/lib/clipboard";
import { cn } from "@executor-js/react/lib/utils";

import type {
  ToolkitAccess,
  ToolkitPolicy,
  ToolkitPolicyAction,
  ToolkitScope,
  ToolkitView,
} from "../shared";
import {
  toolkitsAtom,
  createToolkit,
  updateToolkit,
  removeToolkit,
  toolkitWriteKeys,
} from "./atoms";
import {
  type FormConn as Conn,
  accessFromToolkit,
  connKey,
  entriesFromAccess,
  slugify,
  tiersForScope,
  uniqueSlug,
} from "./form";

// ---------------------------------------------------------------------------
// Local shapes — structural views of the core connection/integration rows we
// read, so this file doesn't pin a specific API success-type name.
// ---------------------------------------------------------------------------

interface Integ {
  readonly slug: string;
  readonly name: string;
}

const ACCESS_OPTIONS: ReadonlyArray<{ value: ToolkitAccess; label: string }> = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "full", label: "Full" },
];

const ACTION_LABEL: Record<ToolkitPolicyAction, string> = {
  approve: "Auto-approve",
  require_approval: "Needs approval",
  block: "Block",
};

// ---------------------------------------------------------------------------
// Access segmented control (off / read / full)
// ---------------------------------------------------------------------------

function AccessSeg(props: {
  value: ToolkitAccess;
  onChange: (v: ToolkitAccess) => void;
}) {
  return (
    <div className="inline-flex shrink-0 gap-0.5 rounded-md border border-input p-0.5">
      {ACCESS_OPTIONS.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="sm"
          variant={props.value === o.value ? "secondary" : "ghost"}
          className="h-6 px-2.5 text-[11px] font-medium"
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function ToolkitCard(props: {
  toolkit: ToolkitView;
  integrationName: (slug: string) => string;
  onOpen: () => void;
}) {
  const active = props.toolkit.connections.filter((c) => c.access !== "off");
  const integrations = [...new Set(active.map((c) => c.integration))];
  return (
    // oxlint-disable-next-line react/forbid-elements -- a card-sized clickable surface; a real <button> is the correct accessible primitive
    <button
      type="button"
      onClick={props.onOpen}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold text-foreground">
          {props.toolkit.name}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {active.length} {active.length === 1 ? "connection" : "connections"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {integrations.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">
            Empty — nothing granted yet
          </span>
        ) : (
          integrations.map((slug) => (
            <span
              key={slug}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[12px]"
            >
              <IntegrationFavicon sourceId={slug} size={14} />
              {props.integrationName(slug)}
            </span>
          ))
        )}
      </div>
      <span className="font-mono text-[10.5px] text-muted-foreground">
        /mcp?toolkit={props.toolkit.slug}
      </span>
    </button>
  );
}

function ListSection(props: {
  title: string;
  empty: string;
  toolkits: ReadonlyArray<ToolkitView>;
  integrationName: (slug: string) => string;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between border-b border-border/50 pb-2">
        <h2 className="font-display text-xl tracking-tight text-foreground">
          {props.title}
        </h2>
        <Button type="button" size="sm" onClick={props.onCreate}>
          New toolkit
        </Button>
      </div>
      {props.toolkits.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          {props.empty}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {props.toolkits.map((tk) => (
            <ToolkitCard
              key={tk.id}
              toolkit={tk}
              integrationName={props.integrationName}
              onOpen={() => props.onOpen(tk.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface EditorProps {
  readonly existing: ToolkitView | null;
  readonly scope: ToolkitScope;
  readonly takenSlugs: ReadonlySet<string>;
  readonly connections: ReadonlyArray<Conn>;
  readonly integrationName: (slug: string) => string;
  readonly onBack: () => void;
  readonly onCreated: () => void;
  readonly onRemoved: () => void;
}

function ToolkitEditor(props: EditorProps) {
  const { existing, scope } = props;

  const [name, setName] = useState(existing?.name ?? "Untitled");
  const [briefing, setBriefing] = useState(existing?.briefing ?? "");
  const [inheritOrg, setInheritOrg] = useState(
    existing?.inheritOrgPolicies ?? true,
  );
  const [access, setAccess] = useState<Record<string, ToolkitAccess>>(
    () => accessFromToolkit(existing).access,
  );
  const [notes, setNotes] = useState<Record<string, string>>(
    () => accessFromToolkit(existing).notes,
  );
  const [policies, setPolicies] = useState<ReadonlyArray<ToolkitPolicy>>(
    () => existing?.policies.map((p) => ({ ...p })) ?? [],
  );

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const doCreate = useAtomSet(createToolkit, { mode: "promiseExit" });
  const doUpdate = useAtomSet(updateToolkit, { mode: "promiseExit" });
  const doRemove = useAtomSet(removeToolkit, { mode: "promiseExit" });

  const mark = () => {
    setDirty(true);
    setError(null);
  };
  const setMode = (key: string, v: ToolkitAccess) => {
    setAccess((m) => ({ ...m, [key]: v }));
    mark();
  };
  const setNote = (key: string, v: string) => {
    setNotes((m) => ({ ...m, [key]: v }));
    mark();
  };
  const setPolicy = (i: number, patch: Partial<ToolkitPolicy>) => {
    setPolicies((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    mark();
  };

  // The connections this toolkit may draw on: workspace = org-owned only;
  // personal = org + the caller's own.
  const tiers = useMemo(
    () => tiersForScope(props.connections, scope),
    [props.connections, scope],
  );

  const buildEntries = () =>
    entriesFromAccess(props.connections, scope, access, notes);

  const cleanPolicies = (): ReadonlyArray<ToolkitPolicy> =>
    policies
      .filter((p) => p.pattern.trim())
      .map((p) => ({ ...p, pattern: p.pattern.trim() }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const connections = buildEntries();
    const cleaned = cleanPolicies();
    if (existing) {
      const exit = await doUpdate({
        params: { id: existing.id },
        payload: {
          name: name.trim() || "Untitled",
          briefing: briefing.trim() ? briefing.trim() : null,
          inheritOrgPolicies: inheritOrg,
          connections,
          policies: cleaned,
        },
        reactivityKeys: toolkitWriteKeys,
      });
      setSaving(false);
      if (Exit.isFailure(exit)) {
        setError("Couldn't save changes. Try again.");
        return;
      }
      setDirty(false);
      return;
    }
    const exit = await doCreate({
      payload: {
        slug: uniqueSlug(slugify(name) || "toolkit", props.takenSlugs),
        name: name.trim() || "Untitled",
        scope,
        inheritOrgPolicies: inheritOrg,
        briefing: briefing.trim() ? briefing.trim() : undefined,
        connections,
        policies: cleaned,
      },
      reactivityKeys: toolkitWriteKeys,
    });
    setSaving(false);
    if (Exit.isFailure(exit)) {
      setError("Couldn't create the toolkit. Try again.");
      return;
    }
    props.onCreated();
  };

  const handleDelete = async () => {
    if (!existing) {
      props.onBack();
      return;
    }
    // oxlint-disable-next-line no-alert -- intentional destructive confirmation
    if (
      !window.confirm(
        "Delete this toolkit? Connected agents lose access immediately.",
      )
    )
      return;
    const exit = await doRemove({
      params: { id: existing.id },
      reactivityKeys: toolkitWriteKeys,
    });
    if (Exit.isSuccess(exit)) props.onRemoved();
    else setError("Couldn't delete the toolkit. Try again.");
  };

  const slug = existing?.slug ?? (slugify(name) || "toolkit");
  const endpoint = `${origin}/mcp?toolkit=${encodeURIComponent(slug)}`;

  // Live "what the agent sees" — derived from the in-progress form.
  const previewGroups = useMemo(() => {
    const byInt = new Map<
      string,
      Array<{ name: string; access: ToolkitAccess; note?: string }>
    >();
    for (const tier of tiers) {
      for (const c of tier.conns) {
        const key = connKey(c.integration, c.name);
        const a = access[key] ?? "off";
        if (a === "off") continue;
        const list = byInt.get(c.integration) ?? [];
        list.push({
          name: c.name,
          access: a,
          note: notes[key]?.trim() || undefined,
        });
        byInt.set(c.integration, list);
      }
    }
    return [...byInt.entries()];
  }, [tiers, access, notes]);
  const previewCount = previewGroups.reduce(
    (n, [, conns]) => n + conns.length,
    0,
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        {/* oxlint-disable-next-line react/forbid-elements -- a subtle text breadcrumb; intentionally not the styled design-system Button */}
        <button
          type="button"
          onClick={props.onBack}
          className="mb-4 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          ← Toolkits
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Input
              value={name}
              onChange={(e) => {
                setName((e.target as HTMLInputElement).value);
                mark();
              }}
              className="h-auto w-full max-w-[420px] border-transparent bg-transparent px-1 font-display text-3xl tracking-tight text-foreground shadow-none focus-visible:border-input"
            />
            <p className="mt-1 px-1 text-[13px] text-muted-foreground">
              {scope === "workspace"
                ? "Workspace toolkit — shared with your org, draws on workspace connections."
                : "Personal toolkit — only you, can use workspace and your own connections."}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 text-destructive/80 hover:text-destructive"
            onClick={handleDelete}
          >
            Delete
          </Button>
        </div>

        <Textarea
          value={briefing}
          onChange={(e) => {
            setBriefing((e.target as HTMLTextAreaElement).value);
            mark();
          }}
          placeholder="What is this toolkit for? This leads the agent's briefing."
          className="mt-1 min-h-[2.25rem] resize-none border-transparent bg-transparent px-0 text-sm text-muted-foreground shadow-none focus-visible:border-input focus-visible:bg-card focus-visible:px-3"
        />

        <div className="mt-6 grid grid-cols-1 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* Main column */}
          <div>
            {/* Access */}
            <h3 className="mb-2.5 text-[13.5px] font-semibold text-foreground">
              Access
            </h3>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {tiers.map((tier, ti) => (
                <div
                  key={tier.label}
                  className={cn(ti > 0 && "border-t border-border")}
                >
                  <div className="flex items-center justify-between px-4 pb-1 pt-3">
                    <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      {tier.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {tier.conns.length} available
                    </span>
                  </div>
                  {tier.conns.length === 0 ? (
                    <p className="px-4 pb-3 text-[12px] text-muted-foreground">
                      No connections in this tier yet.
                    </p>
                  ) : (
                    groupByIntegration(tier.conns).map(([intSlug, conns]) => (
                      <div key={intSlug} className="px-4 pb-2 pt-1.5">
                        <div className="flex items-center gap-2 pb-1">
                          <IntegrationFavicon sourceId={intSlug} size={16} />
                          <span className="text-[12.5px] font-semibold text-foreground">
                            {props.integrationName(intSlug)}
                          </span>
                          {conns.length > 1 && (
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {conns.length} accounts
                            </span>
                          )}
                        </div>
                        {conns.map((c) => {
                          const key = connKey(c.integration, c.name);
                          const a = access[key] ?? "off";
                          return (
                            <div
                              key={key}
                              data-testid={`tk-conn ${key}`}
                              className="pl-7"
                            >
                              <div className="flex items-center gap-3 py-1">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] font-semibold text-foreground">
                                    {c.name}
                                  </div>
                                  {(c.identityLabel || c.description) && (
                                    <div className="truncate text-[11.5px] text-muted-foreground">
                                      {c.identityLabel || c.description}
                                    </div>
                                  )}
                                </div>
                                <AccessSeg
                                  value={a}
                                  onChange={(v) => setMode(key, v)}
                                />
                              </div>
                              {a !== "off" && (
                                <Input
                                  value={notes[key] ?? ""}
                                  onChange={(e) =>
                                    setNote(
                                      key,
                                      (e.target as HTMLInputElement).value,
                                    )
                                  }
                                  placeholder={`Note to the agent about ${c.name} (optional)`}
                                  className="mb-1.5 h-7 border-transparent bg-transparent px-0 text-[12px] italic shadow-none focus-visible:border-input"
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2.5 text-[12px] text-muted-foreground">
              New tools and new connections are included automatically, by mode.
            </p>

            {/* Approvals & policies */}
            <div className="mb-2.5 mt-6 flex items-center justify-between">
              <h3 className="text-[13.5px] font-semibold text-foreground">
                Approvals &amp; policies
              </h3>
              <Label className="flex cursor-pointer items-center gap-2">
                <Switch
                  checked={inheritOrg}
                  onCheckedChange={(v) => {
                    setInheritOrg(v);
                    mark();
                  }}
                />
                <span className="text-[12px] font-medium text-muted-foreground">
                  Inherit org policies
                </span>
              </Label>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="px-4 py-3">
                <p className="text-[12px] text-muted-foreground">
                  {inheritOrg
                    ? "Your workspace's policies apply on top of this toolkit. Where an org rule and a toolkit rule overlap, the stricter one wins."
                    : "Workspace guardrails are off — this toolkit is governed only by its own rules below."}
                </p>
              </div>
              <div className="border-t border-border px-4 py-2.5">
                <div className="flex items-center gap-2 pb-1">
                  <span className="text-[12.5px] font-semibold text-foreground">
                    Toolkit rules
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {policies.length} {policies.length === 1 ? "rule" : "rules"}
                  </span>
                </div>
                {policies.map((p, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 py-1.5"
                  >
                    <Input
                      value={p.pattern}
                      onChange={(e) =>
                        setPolicy(i, {
                          pattern: (e.target as HTMLInputElement).value,
                        })
                      }
                      placeholder="slack.*.post_message"
                      className="h-8 min-w-[190px] flex-1 font-mono text-[12px]"
                    />
                    <Select
                      value={p.action}
                      onValueChange={(v) =>
                        setPolicy(i, { action: v as ToolkitPolicyAction })
                      }
                    >
                      <SelectTrigger className="h-8 w-[150px] text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approve">
                          {ACTION_LABEL.approve}
                        </SelectItem>
                        <SelectItem value="require_approval">
                          {ACTION_LABEL.require_approval}
                        </SelectItem>
                        <SelectItem value="block">
                          {ACTION_LABEL.block}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-destructive/70 hover:text-destructive"
                      onClick={() => {
                        setPolicies((ps) => ps.filter((_, j) => j !== i));
                        mark();
                      }}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPolicies((ps) => [
                        ...ps,
                        { pattern: "", action: "approve" },
                      ]);
                      mark();
                    }}
                  >
                    + Add rule
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    Block hides matching tools entirely · approve /
                    needs-approval set gating.
                  </span>
                </div>
              </div>
            </div>

            {/* Connect */}
            <h3 className="mb-2.5 mt-6 text-[13.5px] font-semibold text-foreground">
              Connect
            </h3>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                MCP endpoint
              </div>
              {/* oxlint-disable-next-line react/forbid-elements -- a full-width copy affordance; the design-system Button doesn't fit this row layout */}
              <button
                type="button"
                onClick={async () => {
                  if (await copyToClipboard(endpoint)) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1100);
                  }
                }}
                className="mt-2 flex w-full items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-left"
              >
                <span className="truncate font-mono text-[12px] text-foreground">
                  {endpoint}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {copied ? "copied" : "copy"}
                </span>
              </button>
              <p className="mt-2.5 text-[11.5px] text-muted-foreground">
                Point an agent at this URL with any of your account's API keys —
                it sees only this toolkit's slice, never the management API.
              </p>
            </div>

            {/* Save bar */}
            <div className="mt-6 flex items-center gap-3">
              <Button
                type="button"
                onClick={handleSave}
                disabled={saving || (!!existing && !dirty)}
              >
                {saving
                  ? "Saving…"
                  : existing
                    ? "Save changes"
                    : "Create toolkit"}
              </Button>
              {error ? (
                <span className="text-[12px] text-destructive">{error}</span>
              ) : existing && !dirty ? (
                <span className="text-[12px] text-muted-foreground">
                  All changes saved
                </span>
              ) : null}
            </div>
          </div>

          {/* Preview rail */}
          <aside className="lg:sticky lg:top-6">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  What the agent sees
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {previewCount}{" "}
                  {previewCount === 1 ? "connection" : "connections"}
                </span>
              </div>
              {briefing.trim() && (
                <p className="mt-3 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
                  {briefing.trim()}
                </p>
              )}
              {previewGroups.length === 0 ? (
                <p className="mt-3 text-[12px] text-muted-foreground">
                  Nothing granted yet — set a connection to Read or Full to give
                  the agent something to work with.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-3">
                  {previewGroups.map(([intSlug, conns]) => (
                    <div key={intSlug}>
                      <div className="flex items-center gap-2">
                        <IntegrationFavicon sourceId={intSlug} size={15} />
                        <span className="text-[12.5px] font-semibold text-foreground">
                          {props.integrationName(intSlug)}
                        </span>
                      </div>
                      {conns.map((c) => (
                        <div key={c.name} className="mt-1 pl-6">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] text-foreground">
                              {c.name}
                            </span>
                            <Badge
                              variant={
                                c.access === "full" ? "default" : "secondary"
                              }
                              className="px-1.5 py-0 text-[10px]"
                            >
                              {c.access === "full" ? "full" : "read-only"}
                            </Badge>
                          </div>
                          {c.note && (
                            <p className="text-[11px] italic text-muted-foreground">
                              {c.note}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function groupByIntegration(
  conns: ReadonlyArray<Conn>,
): ReadonlyArray<readonly [string, ReadonlyArray<Conn>]> {
  const byInt = new Map<string, Conn[]>();
  for (const c of conns) {
    const list = byInt.get(c.integration) ?? [];
    list.push(c);
    byInt.set(c.integration, list);
  }
  return [...byInt.entries()];
}

// ---------------------------------------------------------------------------
// Page — list <-> editor switch
// ---------------------------------------------------------------------------

type View =
  | { readonly kind: "list" }
  | { readonly kind: "edit"; readonly id: string }
  | { readonly kind: "new"; readonly scope: ToolkitScope };

export function ToolkitsPage() {
  const toolkitsResult = useAtomValue(toolkitsAtom);
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const integrationsResult = useAtomValue(integrationsAtom);
  const [view, setView] = useState<View>({ kind: "list" });

  const toolkits = AsyncResult.match(
    toolkitsResult as AsyncResult.AsyncResult<
      ReadonlyArray<ToolkitView>,
      unknown
    >,
    {
      onInitial: () => null,
      onFailure: () => [] as ReadonlyArray<ToolkitView>,
      onSuccess: ({ value }) => value,
    },
  );
  const connections = AsyncResult.match(
    connectionsResult as AsyncResult.AsyncResult<ReadonlyArray<Conn>, unknown>,
    {
      onInitial: () => [] as ReadonlyArray<Conn>,
      onFailure: () => [] as ReadonlyArray<Conn>,
      onSuccess: ({ value }) => value,
    },
  );
  const integrations = AsyncResult.match(
    integrationsResult as AsyncResult.AsyncResult<
      ReadonlyArray<Integ>,
      unknown
    >,
    {
      onInitial: () => [] as ReadonlyArray<Integ>,
      onFailure: () => [] as ReadonlyArray<Integ>,
      onSuccess: ({ value }) => value,
    },
  );

  const integrationName = useMemo(() => {
    const bySlug = new Map(integrations.map((i) => [i.slug, i.name]));
    return (slug: string) => bySlug.get(slug) ?? slug;
  }, [integrations]);

  const takenSlugs = useMemo(
    () => new Set((toolkits ?? []).map((t) => t.slug)),
    [toolkits],
  );

  if (toolkits === null) {
    return (
      <div className="px-1 py-8 text-[13px] text-muted-foreground">
        Loading toolkits…
      </div>
    );
  }

  if (view.kind === "edit" || view.kind === "new") {
    const existing =
      view.kind === "edit"
        ? (toolkits.find((t) => t.id === view.id) ?? null)
        : null;
    // The toolkit was deleted out from under us (or never resolved) — fall back.
    if (view.kind === "edit" && !existing) {
      return <ToolkitEditorFallback onBack={() => setView({ kind: "list" })} />;
    }
    const scope =
      view.kind === "new" ? view.scope : (existing as ToolkitView).scope;
    return (
      <ToolkitEditor
        key={view.kind === "edit" ? view.id : `new-${view.scope}`}
        existing={existing}
        scope={scope}
        takenSlugs={takenSlugs}
        connections={connections}
        integrationName={integrationName}
        onBack={() => setView({ kind: "list" })}
        onCreated={() => setView({ kind: "list" })}
        onRemoved={() => setView({ kind: "list" })}
      />
    );
  }

  const workspace = toolkits.filter((t) => t.scope === "workspace");
  const personal = toolkits.filter((t) => t.scope === "personal");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <header className="mb-2">
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Toolkits
          </h1>
          <p className="mt-1.5 max-w-[640px] text-sm text-muted-foreground">
            A toolkit is a slice of your connections with its own MCP endpoint.
            An agent connected to one can't see anything outside it.
          </p>
        </header>
        <ListSection
          title="Workspace toolkits"
          empty="No workspace toolkits yet — these draw on shared workspace connections."
          toolkits={workspace}
          integrationName={integrationName}
          onOpen={(id) => setView({ kind: "edit", id })}
          onCreate={() => setView({ kind: "new", scope: "workspace" })}
        />
        <ListSection
          title="Personal toolkits"
          empty="No personal toolkits yet — these can use workspace and personal connections."
          toolkits={personal}
          integrationName={integrationName}
          onOpen={(id) => setView({ kind: "edit", id })}
          onCreate={() => setView({ kind: "new", scope: "personal" })}
        />
      </div>
    </div>
  );
}

function ToolkitEditorFallback(props: { onBack: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        {/* oxlint-disable-next-line react/forbid-elements -- a subtle text breadcrumb; intentionally not the styled design-system Button */}
        <button
          type="button"
          onClick={props.onBack}
          className="mb-4 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          ← Toolkits
        </button>
        <p className="text-sm text-muted-foreground">
          This toolkit no longer exists.
        </p>
      </div>
    </div>
  );
}

export default ToolkitsPage;
