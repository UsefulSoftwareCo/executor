import { useAtomMount, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  ManagedSkillId,
  ManagedSkillSourceChange,
  SkillRequirementStatus,
  SkillRevisionId,
  SkillSourceLocator,
} from "@executor-js/sdk/shared";
import { useState } from "react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import { toast } from "sonner";

import {
  removeSkillOptimistic,
  checkSkillSource,
  restoreSkillRevision,
  setSkillDeliveryOptimistic,
  setSkillSource,
  skillAtom,
  skillFileAtom,
  skillsOptimisticAtom,
} from "../api/atoms";
import { skillWriteKeys } from "../api/reactivity-keys";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/alert-dialog";
import { Button } from "../components/button";
import { ErrorState } from "../components/error-state";
import { HelpTooltip } from "../components/help-tooltip";
import { Label } from "../components/label";
import { PageContainer, PageHeader } from "../components/page";
import { Switch } from "../components/switch";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { SkillOwnerTag } from "./skills";

const decodeText = (encoded: string): string => {
  const binary = globalThis.atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const symbolicReferenceFor = (source: SkillSourceLocator): string => {
  return Match.value(source).pipe(
    Match.discriminator("kind")("github", (value) => value.requestedRef),
    Match.discriminator("kind")("wellKnown", (value) => value.entryId),
    Match.discriminator("kind")("mcp", (value) => value.uri),
    Match.discriminator("kind")("local", (value) => value.path),
    Match.exhaustive,
  );
};

const requirementLabel = (status: SkillRequirementStatus): string =>
  Match.value(status.requirement).pipe(
    Match.discriminator("kind")("integration", (value) => `Integration: ${value.integration}`),
    Match.discriminator("kind")("connection", (value) => `Connection: ${value.integration}`),
    Match.discriminator("kind")("mcp", (value) => `MCP server: ${value.integration}`),
    Match.discriminator("kind")(
      "runtime",
      (value) => `Runtime: ${value.command}${value.version ? ` ${value.version}` : ""}`,
    ),
    Match.discriminator("kind")("skill", (value) => `Skill: ${value.name}`),
    Match.exhaustive,
  );

const requirementStatusLabel = (status: SkillRequirementStatus["status"]): string =>
  Match.value(status).pipe(
    Match.when("satisfied", () => "Ready"),
    Match.when("missing", () => "Missing"),
    Match.when("blocked", () => "Blocked"),
    Match.when("needs-user-action", () => "Needs setup"),
    Match.when("unknown", () => "Not checked"),
    Match.exhaustive,
  );

function SkillFile(props: {
  readonly skillId: ManagedSkillId;
  readonly revisionId: SkillRevisionId;
  readonly path: string;
  readonly mediaType: string;
}) {
  const file = useAtomValue(
    skillFileAtom({
      skillId: props.skillId,
      revisionId: props.revisionId,
      path: props.path,
    }),
  );
  const textual =
    props.mediaType.startsWith("text/") ||
    props.mediaType.includes("json") ||
    props.mediaType.includes("yaml") ||
    props.mediaType.includes("xml") ||
    props.mediaType.includes("javascript");
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="cursor-pointer px-4 py-3 font-mono text-xs text-foreground">
        {props.path}
      </summary>
      <div className="border-t border-border bg-muted/30 px-4 py-3">
        {AsyncResult.match(file, {
          onInitial: () => <p className="text-xs text-muted-foreground">Loading file...</p>,
          onFailure: () => <p className="text-xs text-destructive">Could not load this file.</p>,
          onSuccess: ({ value }) =>
            textual ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {decodeText(value.bytes)}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                Binary file, {value.manifest.size.toLocaleString()} bytes.
              </p>
            ),
        })}
      </div>
    </details>
  );
}

export function SkillDetailPage(props: { readonly skillId: ManagedSkillId }) {
  const skill = useAtomValue(skillAtom(props.skillId));
  const refresh = useAtomRefresh(skillAtom(props.skillId));
  useAtomMount(skillsOptimisticAtom);
  const setDelivery = useAtomSet(setSkillDeliveryOptimistic, { mode: "promiseExit" });
  const updateSource = useAtomSet(setSkillSource, { mode: "promiseExit" });
  const checkSource = useAtomSet(checkSkillSource, { mode: "promiseExit" });
  const restoreRevision = useAtomSet(restoreSkillRevision, { mode: "promiseExit" });
  const remove = useAtomSet(removeSkillOptimistic, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [confirmModelInvocation, setConfirmModelInvocation] = useState(false);
  const [checkingSource, setCheckingSource] = useState(false);
  const title = AsyncResult.isSuccess(skill) ? (skill.value.name ?? "Blocked skill") : "Skill";
  useExecutorDocumentTitle(title);

  const changeDelivery = async (
    delivery:
      | { readonly kind: "disabled" }
      | { readonly kind: "enabled"; readonly invocation: "manual" | "model" },
  ) => {
    const exit = await setDelivery({
      params: { skillId: props.skillId },
      payload: { delivery },
      reactivityKeys: skillWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      toast.error("Could not change skill delivery.");
      return;
    }
    refresh();
  };

  const restore = async (revisionId: SkillRevisionId, activeRevisionId: SkillRevisionId) => {
    const exit = await restoreRevision({
      params: { skillId: props.skillId, revisionId },
      payload: { expectedActiveRevisionId: activeRevisionId },
      reactivityKeys: skillWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      toast.error("Could not restore that revision. Refresh and try again.");
      return;
    }
    toast.success("Revision restored");
  };

  const changeSource = async (change: ManagedSkillSourceChange) => {
    const exit = await updateSource({
      params: { skillId: props.skillId },
      payload: { change },
      reactivityKeys: skillWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      toast.error("Could not change skill source tracking.");
      return;
    }
    refresh();
  };

  const checkForUpdates = async () => {
    setCheckingSource(true);
    const exit = await checkSource({
      params: { skillId: props.skillId },
      reactivityKeys: skillWriteKeys,
    });
    setCheckingSource(false);
    if (Exit.isFailure(exit)) {
      toast.error("Could not check this skill source.");
      return;
    }
    if (exit.value.kind === "sourceFailure") {
      toast.error(exit.value.message);
      return;
    }
    if (exit.value.kind === "noUpdate") {
      toast.success("The skill is up to date");
      return;
    }
    await navigate({
      to: "/{-$orgSlug}/skills/$skillId/updates/$candidateId",
      params: { skillId: props.skillId, candidateId: exit.value.candidate.id },
    });
  };

  const handleRemove = async () => {
    const exit = await remove({
      params: { skillId: props.skillId },
      reactivityKeys: skillWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      toast.error("Could not delete the skill.");
      return;
    }
    await navigate({ to: "/{-$orgSlug}/skills" });
  };

  if (isAsyncResultLoading(skill)) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Loading skill...</p>
      </PageContainer>
    );
  }

  return AsyncResult.match(skill, {
    onInitial: () => null,
    onFailure: () => (
      <PageContainer>
        <ErrorState message="This managed skill is unavailable." onRetry={refresh} />
      </PageContainer>
    ),
    onSuccess: ({ value }) => {
      const active = value.revisions.find((revision) => revision.id === value.activeRevisionId);
      const enabled = value.delivery.kind === "enabled";
      const modelInvocation = enabled && value.delivery.invocation === "model";
      const sourceDisablesModelInvocation =
        active?.frontmatter?.["disable-model-invocation"] === true;
      const importedSource = value.source.kind === "imported" ? value.source : null;
      const sourceTracking = importedSource?.tracking ?? null;
      return (
        <PageContainer>
          <div className="mb-4">
            <Link
              to="/{-$orgSlug}/skills"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Skills
            </Link>
          </div>
          <PageHeader
            title={value.name ?? "Blocked skill package"}
            description={value.description ?? "Repair this package before enabling delivery."}
            actions={
              <div className="flex items-center gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to="/{-$orgSlug}/skills/$skillId/edit" params={{ skillId: value.id }}>
                    Edit
                  </Link>
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-destructive">
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this skill?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Executor will remove its revision history and stop delivering it to agents.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => void handleRemove()}>
                        Delete skill
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            }
          />

          <div className="mb-6 flex items-center gap-2">
            <SkillOwnerTag owner={value.owner} />
            <span className="font-mono text-[11px] text-muted-foreground">
              {value.source.kind === "authored" ? "Authored in Executor" : "Imported"}
            </span>
          </div>

          {value.delivery.kind === "blocked" ? (
            <section className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <h2 className="text-sm font-medium text-destructive">Package blocked</h2>
              <ul className="mt-2 space-y-1 text-xs text-destructive">
                {value.delivery.diagnostics.map((diagnostic) => (
                  <li key={`${diagnostic.code}:${diagnostic.path ?? ""}`}>
                    {diagnostic.path ? `${diagnostic.path}: ` : ""}
                    {diagnostic.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section className="mb-6 grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
              <Label className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-sm font-medium">Deliver to agents</span>
                  <span className="block text-xs text-muted-foreground">
                    Disabled skills stay stored but cannot be retrieved.
                  </span>
                </span>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    void changeDelivery(
                      checked ? { kind: "enabled", invocation: "manual" } : { kind: "disabled" },
                    )
                  }
                />
              </Label>
              <Label className="flex items-center justify-between gap-3">
                <span>
                  <span className="flex items-center gap-1 text-sm font-medium">
                    Allow model selection
                    <HelpTooltip label="Allow model selection">
                      {sourceDisablesModelInvocation
                        ? "This skill asks agents not to select it automatically. Changing this switch overrides that preference in Executor."
                        : "Skills use their disable-model-invocation frontmatter as the initial setting. Changing this switch overrides that preference in Executor."}
                    </HelpTooltip>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Opt in to automatic discovery and invocation.
                  </span>
                </span>
                <Switch
                  checked={modelInvocation}
                  disabled={!enabled}
                  onCheckedChange={(checked) => {
                    if (checked) setConfirmModelInvocation(true);
                    else void changeDelivery({ kind: "enabled", invocation: "manual" });
                  }}
                />
              </Label>
              <AlertDialog open={confirmModelInvocation} onOpenChange={setConfirmModelInvocation}>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Allow agents to select this skill?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Executor will include this skill in model discovery. Its instructions can then
                      influence an agent without the user naming it first.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep manual</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => void changeDelivery({ kind: "enabled", invocation: "model" })}
                    >
                      Allow model selection
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </section>
          )}

          {importedSource !== null ? (
            <section className="mb-6 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Source tracking</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {importedSource.locator.kind} ·{" "}
                    {importedSource.tracking.kind === "tracked"
                      ? "Follow for manual update checks"
                      : "Pinned to one upstream revision"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={checkingSource}
                    onClick={() => void checkForUpdates()}
                  >
                    Check for updates
                  </Button>
                  {sourceTracking?.kind === "tracked" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const tracking = importedSource.tracking;
                        if (tracking.kind !== "tracked") return;
                        void changeSource({
                          kind: "setTracking",
                          tracking: {
                            kind: "pinned",
                            upstreamRevision: tracking.resolvedRevision,
                          },
                        });
                      }}
                    >
                      Pin
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const tracking = importedSource.tracking;
                        if (tracking.kind !== "pinned") return;
                        void changeSource({
                          kind: "setTracking",
                          tracking: {
                            kind: "tracked",
                            symbolicReference: symbolicReferenceFor(importedSource.locator),
                            resolvedRevision: tracking.upstreamRevision,
                          },
                        });
                      }}
                    >
                      Follow
                    </Button>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="ghost">
                        Detach source
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Detach this source?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Executor will keep the current package and revision history, but it will
                          no longer check this source for updates.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void changeSource({ kind: "detach" })}>
                          Detach source
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </section>
          ) : null}

          {value.requirementStatuses.length > 0 ? (
            <section className="mb-6">
              <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                  <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Requirements
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Executor reports missing dependencies but never installs or connects them for
                    you.
                  </p>
                </div>
              </div>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {value.requirementStatuses.map((status, index) => {
                  const integration =
                    status.requirement.kind === "integration" ||
                    status.requirement.kind === "connection" ||
                    status.requirement.kind === "mcp"
                      ? status.requirement.integration
                      : null;
                  return (
                    <li
                      key={`${status.requirement.kind}:${requirementLabel(status)}:${index}`}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div>
                        <p className="text-sm text-foreground">
                          {integration === null ? (
                            requirementLabel(status)
                          ) : (
                            <Link
                              to="/{-$orgSlug}/integrations/$namespace"
                              params={{ namespace: integration }}
                              className="hover:underline"
                            >
                              {requirementLabel(status)}
                            </Link>
                          )}
                        </p>
                        {status.evidence ? (
                          <p className="mt-1 text-xs text-muted-foreground">{status.evidence}</p>
                        ) : null}
                      </div>
                      <span
                        className={
                          status.status === "satisfied"
                            ? "text-xs text-success"
                            : status.status === "unknown"
                              ? "text-xs text-muted-foreground"
                              : "text-xs text-destructive"
                        }
                      >
                        {requirementStatusLabel(status.status)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {active ? (
            <section className="mb-6">
              <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Package files
              </h2>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                {active.files.map((file) => (
                  <SkillFile
                    key={file.path}
                    skillId={value.id}
                    revisionId={active.id}
                    path={file.path}
                    mediaType={file.mediaType}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Revision history
            </h2>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {value.revisions.map((revision) => {
                const isActive = revision.id === value.activeRevisionId;
                return (
                  <li
                    key={revision.id}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div>
                      <p className="font-mono text-xs text-foreground">
                        {revision.packageDigest.slice(0, 20)}...
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatRelativeTime(revision.createdAt)}
                        {isActive ? " · Active" : ""}
                      </p>
                    </div>
                    {!isActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void restore(revision.id, value.activeRevisionId)}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        </PageContainer>
      );
    },
  });
}
