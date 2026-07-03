import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import {
  rankResponseSample,
  type AuthTemplateSlug,
  type HealthCheckCandidate,
  type HealthCheckResult,
  type HealthCheckSpec,
  type IntegrationSlug,
  type Owner,
} from "@executor-js/sdk/shared";
import { toast } from "sonner";

import {
  integrationHealthCheckAtom,
  integrationHealthCheckCandidatesAtom,
  setIntegrationHealthCheck,
  validateConnection,
} from "../api/atoms";
import { healthCheckWriteKeys } from "../api/reactivity-keys";
import { messageFromExit } from "../api/error-reporting";
import { HEALTH_STATUS_LABEL, HEALTH_TEXT_CLASS } from "../lib/health-display";
import { Button } from "./button";
import { FreeformCombobox, type FreeformComboboxOption } from "./combobox";
import { Input } from "./input";
import { Label } from "./label";
import { NativeSelect, NativeSelectOption } from "./native-select";
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
// authenticated call tells us a connection is still alive and (optionally) whose
// account it is". It is the same shape as configuring an auth method: pick one of
// the integration's operations (ranked so the obvious read-only identity endpoint
// floats up), optionally pin the required arguments (Google's People API needs
// `resourceName=people/me`), and optionally name a response field to show as the
// account identity.
//
// Identity is a facet, not the point: with no identity field the check degrades
// to a pure "alive / expired" probe. The typed identity picker and the live
// preview (a real probe against a pasted test key, showing the response) exist so
// the user can SEE what the operation returns and pick the right field.
//
// The check is run per-connection elsewhere (the AccountRow "Check now" probe and
// the key-first connect validation); this surface only declares it.
//
// It hides itself when the owning integration exposes no candidate operations AND
// none is configured (i.e. the plugin has no health-check capability), so it
// costs nothing on integrations that can't support it.
// ---------------------------------------------------------------------------

/** Context the edit sheet needs to run a live preview: which owner to probe as
 *  and the credential auth-templates a pasted test key can be validated against.
 *  Absent (or empty) on surfaces with no persisted integration yet (the add
 *  screen), where the preview is suppressed. */
export interface HealthCheckLivePreview {
  readonly owner: Owner;
  readonly templates: ReadonlyArray<{
    readonly template: AuthTemplateSlug;
    readonly label: string;
  }>;
}

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
// HealthCheckConfigFields: the presentational operation + identity + pinned-arg
// form, shared by the edit sheet and the add-integration screen so the two stay
// in lockstep. State (and the `selected` candidate) is owned by the parent; this
// component only renders and reports edits.
// ---------------------------------------------------------------------------

function HealthCheckConfigFields(props: {
  readonly candidates: readonly HealthCheckCandidate[];
  readonly selected: HealthCheckCandidate | null;
  readonly operation: string;
  readonly onOperationChange: (operation: string) => void;
  readonly identityField: string;
  readonly onIdentityFieldChange: (path: string) => void;
  readonly args: Record<string, string>;
  readonly onArgChange: (name: string, value: string) => void;
  readonly disabled?: boolean;
  readonly idPrefix: string;
}) {
  const { candidates, selected, operation, identityField, args, disabled, idPrefix } = props;

  const operationOptions = useMemo<FreeformComboboxOption[]>(
    () =>
      candidates.map((c) => ({
        value: c.operation,
        label: candidateLabel(c),
        description: c.summary,
      })),
    [candidates],
  );

  // The identity picker is a typed combobox over the operation's response fields,
  // with a leading "None" that clears the field (pure health check). It stays
  // freeform so a custom dot-path the projector missed is still reachable.
  const identityOptions = useMemo<FreeformComboboxOption[]>(
    () => [
      {
        value: "",
        label: "None - health check only",
        description: "Status only, no account identity",
      },
      ...(selected?.responseFields ?? []).map((f) => ({
        value: f.path,
        label: f.path,
        description: f.type,
      })),
    ],
    [selected],
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
              Pinned into every probe. An identity endpoint often needs a fixed value here (for
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

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-identity`}>Identity field</Label>
        <FreeformCombobox
          id={`${idPrefix}-identity`}
          value={identityField}
          onValueChange={props.onIdentityFieldChange}
          options={identityOptions}
          placeholder="None - health check only"
          emptyLabel="No response fields detected"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Optional. Pick a response field whose value labels the connected account (
          <span className="font-mono">user.login</span>,{" "}
          <span className="font-mono">emailAddresses.0.value</span>). Leave as{" "}
          <span className="font-mono">None</span> for a pure health check. Numeric segments index
          arrays.
        </p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Live preview: runs the drafted check against a pasted test key WITHOUT
// saving it (the same `validateConnection` probe the key-first connect uses),
// then shows the real response so the user can confirm the status and see which
// field carries the identity. Edit-sheet only: it needs a persisted integration
// and a credential template, neither of which exists on the add screen.
// ---------------------------------------------------------------------------

function HealthCheckLivePreviewBlock(props: {
  readonly integration: IntegrationSlug;
  readonly preview: HealthCheckLivePreview;
  readonly operation: string;
  readonly identityField: string;
  readonly args: Record<string, string>;
  readonly disabled: boolean;
}) {
  const { integration, preview, operation, identityField, args, disabled } = props;
  const doValidate = useAtomSet(validateConnection, { mode: "promiseExit" });

  const [value, setValue] = useState("");
  const [template, setTemplate] = useState<string>(preview.templates[0]?.template ?? "");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HealthCheckResult | null>(null);

  const handlePreview = async () => {
    const credential = value.trim();
    if (operation.length === 0 || credential.length === 0) return;
    const slug = (template || preview.templates[0]?.template) as AuthTemplateSlug | undefined;
    if (slug === undefined) return;
    const identity = identityField.trim();
    const argEntries = Object.entries(args)
      .map(([key, v]) => [key, v.trim()] as const)
      .filter(([, v]) => v.length > 0);
    const spec: HealthCheckSpec = {
      operation,
      ...(argEntries.length > 0 ? { args: Object.fromEntries(argEntries) } : {}),
      ...(identity.length > 0 ? { identityField: identity } : {}),
    };
    setRunning(true);
    const exit = await doValidate({
      payload: { owner: preview.owner, integration, template: slug, value: credential, spec },
    });
    setRunning(false);
    if (Exit.isFailure(exit)) {
      setResult(null);
      toast.error(messageFromExit(exit, "Couldn't run the preview"));
      return;
    }
    setResult(exit.value);
  };

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Live preview</p>
        <p className="text-xs text-muted-foreground">
          Paste a test credential to run this check now. Nothing is saved; the response below is
          what the operation returns.
        </p>
      </div>

      {preview.templates.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor="health-check-preview-template">Auth method</Label>
          <NativeSelect
            id="health-check-preview-template"
            className="w-full text-sm"
            value={template}
            disabled={disabled || running}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTemplate(e.target.value)}
          >
            {preview.templates.map((t) => (
              <NativeSelectOption key={String(t.template)} value={String(t.template)}>
                {t.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="health-check-preview-key">Test credential</Label>
        <div className="flex gap-2">
          <Input
            id="health-check-preview-key"
            type="password"
            value={value}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
            placeholder="Paste a key to probe"
            disabled={disabled || running}
            className="flex-1"
          />
          <Button
            variant="outline"
            onClick={() => void handlePreview()}
            disabled={disabled || running || operation.length === 0 || value.trim().length === 0}
          >
            {running ? "Running..." : "Preview"}
          </Button>
        </div>
      </div>

      {result ? (
        <div className="space-y-2">
          <p className="text-sm">
            Status:{" "}
            <span className={`font-medium ${HEALTH_TEXT_CLASS[result.status]}`}>
              {HEALTH_STATUS_LABEL[result.status]}
            </span>
            {result.httpStatus !== undefined ? (
              <span className="ml-1.5 text-xs text-muted-foreground">
                (HTTP {result.httpStatus})
              </span>
            ) : null}
          </p>
          {identityField.trim().length > 0 ? (
            <p className="text-sm">
              Resolves to:{" "}
              {result.identity ? (
                <span className="font-mono">{result.identity}</span>
              ) : (
                <span className="text-muted-foreground">no value at this field</span>
              )}
            </p>
          ) : null}
          {result.detail ? <p className="text-xs text-muted-foreground">{result.detail}</p> : null}
          {result.responseSample && result.responseSample.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Response</p>
              <dl className="space-y-0.5 rounded border border-border/50 bg-background/60 p-2 font-mono text-[11px]">
                {rankResponseSample(result.responseSample).map((row) => (
                  <div key={row.path} className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">{row.path}</dt>
                    <dd className="min-w-0 truncate text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HealthCheckEditorSheet(props: {
  readonly integration: IntegrationSlug;
  readonly spec: HealthCheckSpec | null;
  readonly candidates: readonly HealthCheckCandidate[];
  readonly livePreview?: HealthCheckLivePreview;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { integration, spec, candidates, livePreview, open, onOpenChange } = props;
  const doSet = useAtomSet(setIntegrationHealthCheck, { mode: "promiseExit" });

  const [operation, setOperation] = useState("");
  const [identityField, setIdentityField] = useState("");
  // Pinned argument values keyed by parameter name; stored as strings (the form
  // input value) and trimmed/dropped when empty at save.
  const [args, setArgs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Re-seed the drafts from the persisted spec each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setOperation(spec?.operation ?? candidates[0]?.operation ?? "");
    setIdentityField(spec?.identityField ?? "");
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
    // Parameters and the response shape differ per operation; drop the prior
    // pick's pinned args and identity path so neither dangles onto a new op.
    setArgs({});
    setIdentityField("");
  };

  const onArgChange = (name: string, value: string) =>
    setArgs((prev) => ({ ...prev, [name]: value }));

  const handleSave = async () => {
    if (operation.length === 0) return;
    setSaving(true);
    const identity = identityField.trim();
    const argEntries = Object.entries(args)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0);
    const nextSpec: HealthCheckSpec = {
      operation,
      ...(argEntries.length > 0 ? { args: Object.fromEntries(argEntries) } : {}),
      ...(identity.length > 0 ? { identityField: identity } : {}),
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

  const canPreview = livePreview !== undefined && livePreview.templates.length > 0;

  return (
    // Non-modal: a modal sheet's `react-remove-scroll` locks the wheel to the
    // sheet subtree, so the operation combobox's portaled popup can't scroll.
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Health check</SheetTitle>
          <SheetDescription>
            One read-only call Executor runs to tell whether a connection's credential is still
            alive and, optionally, whose account it is. A 401 or 403 marks the connection expired.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4">
          <HealthCheckConfigFields
            candidates={candidates}
            selected={selected}
            operation={operation}
            onOperationChange={onOperationChange}
            identityField={identityField}
            onIdentityFieldChange={setIdentityField}
            args={args}
            onArgChange={onArgChange}
            disabled={saving}
            idPrefix="health-check"
          />

          {canPreview ? (
            <HealthCheckLivePreviewBlock
              integration={integration}
              preview={livePreview}
              operation={operation}
              identityField={identityField}
              args={args}
              disabled={saving}
            />
          ) : null}
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

export function HealthCheckEditor(props: {
  readonly integration: IntegrationSlug;
  readonly livePreview?: HealthCheckLivePreview;
}) {
  const { integration, livePreview } = props;
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
          A read-only call Executor runs to tell whether a connection's credential is still alive
          and, optionally, whose account it is.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
        <div className="min-w-0 space-y-0.5">
          {spec ? (
            <>
              <p className="truncate font-mono text-xs text-foreground">
                {specSummary(spec, candidates)}
              </p>
              {spec.identityField ? (
                <p className="truncate text-xs text-muted-foreground">
                  Identity: <span className="font-mono">{spec.identityField}</span>
                </p>
              ) : (
                <p className="truncate text-xs text-muted-foreground">
                  Health check only (no identity).
                </p>
              )}
            </>
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
        livePreview={livePreview}
        open={open}
        onOpenChange={setOpen}
      />
    </section>
  );
}

// Re-exported so the add-integration screen can compose the same operation +
// identity form without the sheet/live-preview chrome.
export { HealthCheckConfigFields };
