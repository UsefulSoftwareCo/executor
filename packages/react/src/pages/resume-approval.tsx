import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option, Schema } from "effect";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Check, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { pausedExecutionAtom, resumeExecution } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { type ElicitationAction, useElicitationApproval } from "../components/elicitation-approval";
import { Skeleton } from "../components/skeleton";

type PausedExecutionInfo = { readonly text: string; readonly structured: unknown };
type ResumeExecutionResult =
  | {
      readonly status: "completed";
      readonly text: string;
      readonly structured: unknown;
      readonly isError: boolean;
    }
  | {
      readonly status: "paused";
      readonly text: string;
      readonly structured: unknown;
    };

type ResumeStatus =
  | { readonly state: "idle" }
  | { readonly state: "submitting"; readonly action: ElicitationAction }
  | { readonly state: "done"; readonly action: ElicitationAction; readonly text: string }
  | { readonly state: "failed"; readonly message: string };

const actionLabel: Record<ElicitationAction, string> = {
  accept: "Approve",
  decline: "Decline",
  cancel: "Cancel",
};

const returnPrompt: Record<ElicitationAction, string> = {
  accept: "I've approved it",
  decline: "I've denied it",
  cancel: "I've canceled it",
};

type PausedInteractionView = {
  readonly kind: string | null;
  readonly message: string;
  readonly title: string;
  readonly args: unknown;
  readonly url: string | null;
  readonly requestedSchema: unknown;
  readonly toolId: string | null;
};

const encodeJsonPreview = Schema.encodeUnknownOption(Schema.UnknownFromJsonString);
const decodeJsonPreview = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const PausedInteractionInfo = Schema.Struct({
  kind: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.String),
  requestedSchema: Schema.optional(Schema.Unknown),
  toolId: Schema.optional(Schema.String),
});
const PausedStructured = Schema.Struct({
  executionId: Schema.optional(Schema.String),
  interaction: Schema.optional(PausedInteractionInfo),
});
const decodePausedStructured = Schema.decodeUnknownOption(PausedStructured);

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "Resume failed.";
  return "The paused execution could not be resumed. It may have already completed or expired.";
};

const requestedSchemaFromPausedInfo = (paused: PausedExecutionInfo | null): unknown =>
  paused ? interactionFromPausedInfo(paused)?.requestedSchema : undefined;

const safeJson = (value: unknown): string | null => Option.getOrNull(encodeJsonPreview(value));

const parseArgumentsFromMessage = (message: string): unknown => {
  const marker = "\n\nArguments:\n";
  const index = message.indexOf(marker);
  if (index === -1) return undefined;
  const raw = message.slice(index + marker.length).trim();
  return Option.getOrUndefined(decodeJsonPreview(raw));
};

const messageTitle = (message: string): string => {
  const marker = "\n\nArguments:\n";
  const first = (message.includes(marker) ? message.slice(0, message.indexOf(marker)) : message)
    .trim()
    .split("\n")
    .find((line) => line.trim().length > 0);
  return first?.trim() || "Paused tool call";
};

const interactionFromPausedInfo = (paused: PausedExecutionInfo): PausedInteractionView | null => {
  const structured = Option.getOrNull(decodePausedStructured(paused.structured));
  const interaction = structured?.interaction;
  if (!interaction) return null;
  const message = interaction.message ?? paused.text;
  const args = interaction.args ?? parseArgumentsFromMessage(message);
  return {
    kind: interaction.kind ?? null,
    message,
    title: messageTitle(message),
    args,
    url: interaction.url ?? null,
    requestedSchema: interaction.requestedSchema,
    toolId: interaction.toolId ?? null,
  };
};

const executionIdFromStructured = (structured: unknown): string | null =>
  Option.getOrNull(decodePausedStructured(structured))?.executionId ?? null;

export function ResumeApprovalPage(props: { executionId: string }) {
  const paused = useAtomValue(pausedExecutionAtom(props.executionId));
  const doResume = useAtomSet(resumeExecution, { mode: "promiseExit" });

  const resume = useCallback(
    (executionId: string, action: ElicitationAction, content?: Record<string, unknown>) =>
      doResume({
        params: { executionId },
        payload: action === "accept" ? { action, content: content ?? {} } : { action },
      }),
    [doResume],
  );

  return <ResumeApprovalPageView executionId={props.executionId} paused={paused} resume={resume} />;
}

export function ResumeApprovalPageView(props: {
  executionId: string;
  paused: AsyncResult.AsyncResult<PausedExecutionInfo, unknown>;
  resume: (
    executionId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
  ) => Promise<Exit.Exit<ResumeExecutionResult, unknown>>;
  unavailableMessage?: string;
}) {
  const { executionId, paused, resume, unavailableMessage } = props;
  const [status, setStatus] = useState<ResumeStatus>({ state: "idle" });
  const [currentExecutionId, setCurrentExecutionId] = useState(executionId);
  const [nextPaused, setNextPaused] = useState<PausedExecutionInfo | null>(null);
  const displayedPaused = nextPaused ?? (AsyncResult.isSuccess(paused) ? paused.value : null);
  const approval = useElicitationApproval(requestedSchemaFromPausedInfo(displayedPaused));
  const interaction = displayedPaused ? interactionFromPausedInfo(displayedPaused) : null;

  useEffect(() => {
    setCurrentExecutionId(executionId);
    setNextPaused(null);
    setStatus({ state: "idle" });
  }, [executionId]);

  const shortExecutionId = useMemo(
    () =>
      currentExecutionId.length > 24
        ? `${currentExecutionId.slice(0, 12)}...${currentExecutionId.slice(-6)}`
        : currentExecutionId,
    [currentExecutionId],
  );

  const submit = useCallback(
    async (action: ElicitationAction) => {
      const content = action === "accept" ? approval.content() : undefined;
      if (content === null) return;

      setStatus({ state: "submitting", action });
      const exit = await resume(currentExecutionId, action, content);

      if (Exit.isFailure(exit)) {
        trackEvent("resume_approval_submitted", {
          action,
          ...(interaction?.kind != null ? { interaction_kind: interaction.kind } : {}),
          chained_to_next: false,
          success: false,
        });
        setStatus({ state: "failed", message: failureMessage(exit) });
        return;
      }

      if (exit.value.status === "paused") {
        const nextExecutionId = executionIdFromStructured(exit.value.structured);
        if (!nextExecutionId) {
          trackEvent("resume_approval_submitted", {
            action,
            ...(interaction?.kind != null ? { interaction_kind: interaction.kind } : {}),
            chained_to_next: false,
            success: false,
          });
          setStatus({
            state: "failed",
            message: "The next paused execution did not include an id.",
          });
          return;
        }

        trackEvent("resume_approval_submitted", {
          action,
          ...(interaction?.kind != null ? { interaction_kind: interaction.kind } : {}),
          chained_to_next: true,
          success: true,
        });
        setCurrentExecutionId(nextExecutionId);
        setNextPaused({ text: exit.value.text, structured: exit.value.structured });
        setStatus({ state: "idle" });
        return;
      }

      trackEvent("resume_approval_submitted", {
        action,
        ...(interaction?.kind != null ? { interaction_kind: interaction.kind } : {}),
        chained_to_next: false,
        success: true,
      });
      setStatus({
        state: "done",
        action,
        text: exit.value.text || "The paused execution has been resumed.",
      });
    },
    [approval, currentExecutionId, interaction, resume],
  );

  const busy = status.state === "submitting";
  const done = status.state === "done";
  const canSubmit = Boolean(displayedPaused) && !busy && !done;

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 py-8">
      <section className="flex max-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex shrink-0 items-start gap-4 border-b border-border px-5 py-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              User approval required
            </p>
            <h1 className="mt-1 text-xl font-semibold text-foreground">Resume execution</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              A paused tool call is waiting for your decision before it can continue.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {nextPaused ? (
            <PendingRequestDetails interaction={interaction} approvalFields={approval.fields} />
          ) : (
            AsyncResult.match(paused, {
              onInitial: () => (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ),
              onFailure: () => (
                <div className="text-sm leading-6 text-muted-foreground">
                  {unavailableMessage ??
                    "This paused execution is no longer available. It may have already been resumed, or the local daemon may have restarted."}
                </div>
              ),
              onSuccess: () => (
                <PendingRequestDetails interaction={interaction} approvalFields={approval.fields} />
              ),
            })
          )}
        </div>

        {status.state === "failed" && (
          <div className="mx-5 mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {status.message}
          </div>
        )}

        {done && (
          <div className="mx-5 mb-4 rounded-md border border-border bg-muted px-3 py-2">
            <p className="text-sm font-medium text-foreground">{actionLabel[status.action]} sent</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Return to your agent and let it continue.
            </p>
          </div>
        )}

        <div className="flex shrink-0 flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 rounded-md bg-muted/50 px-2.5 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">Execution </span>
            <code className="break-all font-mono text-xs text-foreground">{shortExecutionId}</code>
          </div>
          {done ? (
            <CopyButton
              value={returnPrompt[status.action]}
              label="Copy prompt"
              className="h-9 px-4"
              onCopy={() => trackEvent("resume_return_prompt_copied", { action: status.action })}
            />
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={!canSubmit}
                onClick={() => void submit("cancel")}
              >
                {busy && status.action === "cancel" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <X className="size-4" aria-hidden="true" />
                )}
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!canSubmit}
                onClick={() => void submit("decline")}
              >
                {busy && status.action === "decline" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <X className="size-4" aria-hidden="true" />
                )}
                Decline
              </Button>
              <Button type="button" disabled={!canSubmit} onClick={() => void submit("accept")}>
                {busy && status.action === "accept" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="size-4" aria-hidden="true" />
                )}
                Approve
              </Button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function PendingRequestDetails({
  interaction,
  approvalFields,
}: {
  interaction: PausedInteractionView | null;
  approvalFields: ReactNode;
}) {
  if (!interaction) {
    return <div className="text-sm text-muted-foreground">No pending request details found.</div>;
  }

  const argsJson = interaction.args === undefined ? null : safeJson(interaction.args);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pending request
        </div>
        <div className="break-words text-base font-semibold text-foreground">
          {interaction.title}
        </div>
        {interaction.toolId && (
          <div className="font-mono text-xs text-muted-foreground">{interaction.toolId}</div>
        )}
      </div>

      {interaction.url && (
        <Button type="button" variant="outline" size="sm" asChild>
          <a href={interaction.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" aria-hidden="true" />
            Open link
          </a>
        </Button>
      )}

      {argsJson && (
        <div className="rounded-md border border-border bg-background">
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            Arguments
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5 text-foreground">
            {argsJson}
          </pre>
        </div>
      )}

      {approvalFields && (
        <div className="rounded-md border border-border bg-muted/30 p-3">{approvalFields}</div>
      )}
    </div>
  );
}
