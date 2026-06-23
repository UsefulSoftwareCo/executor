import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import {
  type HealthCheckCandidate,
  type HealthCheckSpec,
  type IntegrationSlug,
} from "@executor-js/sdk/shared";
import { toast } from "sonner";

import {
  integrationHealthCheckAtom,
  integrationHealthCheckCandidatesAtom,
  setIntegrationHealthCheck,
} from "../api/atoms";
import { healthCheckWriteKeys } from "../api/reactivity-keys";
import { messageFromExit } from "../api/error-reporting";
import { Button } from "./button";
import { FreeformCombobox, type FreeformComboboxOption } from "./combobox";
import { Input } from "./input";
import { Label } from "./label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "./sheet";

// ---------------------------------------------------------------------------
// Health-check editor: the integration-level configuration for "what single
// authenticated call tells us a connection is still alive". It is the same shape
// as configuring an auth method: pick one of the integration's operations (ranked
// so the obvious read-only endpoint floats up) and optionally pin the required
// arguments (Google's People API needs `resourceName=people/me`).
//
// The check is run per-connection elsewhere (the AccountRow "Check now" probe);
// this surface only declares it.
//
// It hides itself when the owning integration exposes no candidate operations AND
// none is configured (i.e. the plugin has no health-check capability), so it
// costs nothing on integrations that can't support it.
// ---------------------------------------------------------------------------

/** "GET /users/me" style label for a candidate, with a writes marker so a
 *  mutating operation picked as a health check reads as the hazard it is. */
const candidateLabel = (candidate: HealthCheckCandidate): string => {
  const head = `${candidate.method.toUpperCase()} ${candidate.operation}`;
  return candidate.destructive ? `${head} (writes)` : head;
};

/** The summary line for the configured spec: the operation, prefixed with its
 *  method when we can still find it among the candidates. */
const specSummary = (
  spec: HealthCheckSpec,
  candidates: readonly HealthCheckCandidate[],
): string => {
  const match = candidates.find((c) => c.operation === spec.operation);
  return match ? `${match.method.toUpperCase()} ${spec.operation}` : spec.operation;
};

// ---------------------------------------------------------------------------
// HealthCheckConfigFields: the presentational operation + pinned-arg form,
// shared by the edit sheet and the add-integration screen so the two stay in
// lockstep. State (and the `selected` candidate) is owned by the parent; this
// component only renders and reports edits.
// ---------------------------------------------------------------------------

function HealthCheckConfigFields(props: {
  readonly candidates: readonly HealthCheckCandidate[];
  readonly selected: HealthCheckCandidate | null;
  readonly operation: string;
  readonly onOperationChange: (operation: string) => void;
  readonly args: Record<string, string>;
  readonly onArgChange: (name: string, value: string) => void;
  readonly disabled?: boolean;
  readonly idPrefix: string;
}) {
  const { candidates, selected, operation, args, disabled, idPrefix } = props;

  const operationOptions = useMemo<FreeformComboboxOption[]>(
    () =>
      candidates.map((c) => ({
        value: c.operation,
        label: candidateLabel(c),
        description: c.summary,
      })),
    [candidates],
  );

  const requiredParams = useMemo(
    () => (selected?.parameters ?? []).filter((p) => p.required),
    [selected],
  );

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-operation`}>Operation</Label>
        <FreeformCombobox
          id={`${idPrefix}-operation`}
          value={operation}
          onValueChange={props.onOperationChange}
          options={operationOptions}
          placeholder={candidates.length === 0 ? "No operations available" : "Pick an operation"}
          emptyLabel="No matching operations"
          disabled={disabled}
        />
        {selected?.summary ? (
          <p className="text-xs text-muted-foreground">{selected.summary}</p>
        ) : null}
        {selected?.destructive ? (
          <p className="text-xs text-destructive">
            This operation writes data. Prefer a read-only (GET) operation for a health check.
          </p>
        ) : null}
      </div>

      {requiredParams.length > 0 ? (
        <div className="space-y-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Required arguments</p>
            <p className="text-xs text-muted-foreground">
              Pinned into every probe. A liveness endpoint often needs a fixed value here (for
              example <span className="font-mono">resourceName</span> ={" "}
              <span className="font-mono">people/me</span>).
            </p>
          </div>
          {requiredParams.map((param) => (
            <div key={param.name} className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-arg-${param.name}`}>
                {param.name}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({param.location})
                </span>
              </Label>
              <Input
                id={`${idPrefix}-arg-${param.name}`}
                value={args[param.name] ?? ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  props.onArgChange(param.name, e.target.value)
                }
                placeholder={param.description ?? `Value for ${param.name}`}
                disabled={disabled}
              />
              {param.description ? (
                <p className="text-xs text-muted-foreground">{param.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function HealthCheckEditorSheet(props: {
  readonly integration: IntegrationSlug;
  readonly spec: HealthCheckSpec | null;
  readonly candidates: readonly HealthCheckCandidate[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { integration, spec, candidates, open, onOpenChange } = props;
  const doSet = useAtomSet(setIntegrationHealthCheck, { mode: "promiseExit" });

  const [operation, setOperation] = useState("");
  // Pinned argument values keyed by parameter name; stored as strings (the form
  // input value) and trimmed/dropped when empty at save.
  const [args, setArgs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Re-seed the drafts from the persisted spec each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setOperation(spec?.operation ?? candidates[0]?.operation ?? "");
    setArgs(
      spec?.args
        ? Object.fromEntries(
            Object.entries(spec.args).map(([key, value]) => [
              key,
              value == null ? "" : String(value),
            ]),
          )
        : {},
    );
  }, [open, spec, candidates]);

  const selected = useMemo(
    () => candidates.find((c) => c.operation === operation) ?? null,
    [candidates, operation],
  );

  const requiredParams = useMemo(
    () => (selected?.parameters ?? []).filter((p) => p.required),
    [selected],
  );
  const missingRequired = requiredParams.some((p) => (args[p.name] ?? "").trim().length === 0);

  const onOperationChange = (next: string) => {
    setOperation(next);
    // Parameters differ per operation; drop the prior pick's pinned args so none
    // dangle onto a new op.
    setArgs({});
  };

  const onArgChange = (name: string, value: string) =>
    setArgs((prev) => ({ ...prev, [name]: value }));

  const handleSave = async () => {
    if (operation.length === 0) return;
    setSaving(true);
    const argEntries = Object.entries(args)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0);
    const nextSpec: HealthCheckSpec = {
      operation,
      ...(argEntries.length > 0 ? { args: Object.fromEntries(argEntries) } : {}),
    };
    const exit = await doSet({
      params: { slug: integration },
      payload: { spec: nextSpec },
      reactivityKeys: healthCheckWriteKeys,
    });
    setSaving(false);
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Failed to save health check"));
      return;
    }
    toast.success("Health check saved");
    onOpenChange(false);
  };

  const handleClear = async () => {
    setSaving(true);
    const exit = await doSet({
      params: { slug: integration },
      payload: { spec: null },
      reactivityKeys: healthCheckWriteKeys,
    });
    setSaving(false);
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Failed to clear health check"));
      return;
    }
    toast.success("Health check cleared");
    onOpenChange(false);
  };

  return (
    // Non-modal: a modal sheet's `react-remove-scroll` locks the wheel to the
    // sheet subtree, so the operation combobox's portaled popup can't scroll.
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Health check</SheetTitle>
          <SheetDescription>
            One read-only call Executor runs to tell whether a connection's credential is still
            alive. A 401 or 403 marks the connection expired.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4">
          <HealthCheckConfigFields
            candidates={candidates}
            selected={selected}
            operation={operation}
            onOperationChange={onOperationChange}
            args={args}
            onArgChange={onArgChange}
            disabled={saving}
            idPrefix="health-check"
          />
        </div>

        <SheetFooter>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || operation.length === 0 || missingRequired}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          {spec ? (
            <Button variant="outline" onClick={() => void handleClear()} disabled={saving}>
              Clear
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function HealthCheckEditor(props: { readonly integration: IntegrationSlug }) {
  const { integration } = props;
  const specResult = useAtomValue(integrationHealthCheckAtom(integration));
  const candidatesResult = useAtomValue(integrationHealthCheckCandidatesAtom(integration));
  const [open, setOpen] = useState(false);

  const spec = AsyncResult.isSuccess(specResult) ? specResult.value : null;
  const candidates: readonly HealthCheckCandidate[] = AsyncResult.isSuccess(candidatesResult)
    ? candidatesResult.value
    : [];

  // No capability (no candidate operations) and nothing configured: render
  // nothing. This also covers the still-loading window, so the section doesn't
  // flash an empty shell before the candidates arrive.
  if (candidates.length === 0 && spec === null) return null;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Health check</h3>
        <p className="text-xs text-muted-foreground">
          A read-only call Executor runs to tell whether a connection's credential is still alive.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
        <div className="min-w-0 space-y-0.5">
          {spec ? (
            <p className="truncate font-mono text-xs text-foreground">
              {specSummary(spec, candidates)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No health check configured.</p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {spec ? "Edit" : "Set up"}
        </Button>
      </div>
      <HealthCheckEditorSheet
        integration={integration}
        spec={spec}
        candidates={candidates}
        open={open}
        onOpenChange={setOpen}
      />
    </section>
  );
}

// Re-exported so the add-integration screen can compose the same operation +
// pinned-arg form without the sheet chrome.
export { HealthCheckConfigFields };
