import { useEffect, useState } from "react";
import { Cause, Exit, Option, Schema } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ConsentDelegationBody,
  CreateDelegatedKeyBody,
  DelegatedCredentialSummary,
  DelegatedCredentialsResponse,
  DelegationChallengeResponse,
  DelegationScope,
  DelegationTarget,
} from "@executor-js/api";
import {
  consentDelegationChallenge,
  createDelegatedKey,
  delegatedCredentialsOptimisticAtom,
  delegationAuditAtom,
  delegationChallengeAtom,
  delegationNotificationsAtom,
  delegationScopeOptionsAtom,
  delegationTargetsAtom,
  type DelegationScopeOptions,
  markDelegationNotificationRead,
  revokeAllDelegatedCredentialsOptimistic,
  revokeDelegatedCredentialOptimistic,
  rotateDelegatedKey,
  startDelegationChallenge,
} from "../api/account-atoms";
import { delegatedCredentialWriteKeys } from "../api/reactivity-keys";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { ErrorState } from "../components/error-state";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { PageContainer, PageHeader } from "../components/page";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";

type Scope = typeof DelegationScope.Type;
type Target = typeof DelegationTarget.Type;
type Credential = typeof DelegatedCredentialSummary.Type;
type CredentialsResponse = typeof DelegatedCredentialsResponse.Type;
type Challenge = typeof DelegationChallengeResponse.Type;
type ScopeOptions = DelegationScopeOptions;
type ConnectionMode = "toolkit" | "none" | "selected";
const decodeFailureMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

const defaultExpiry = (): string => {
  const value = new Date();
  value.setDate(value.getDate() + 30);
  return value.toISOString().slice(0, 10);
};

const expiryTimestamp = (value: string): string => new Date(`${value}T23:59:59.000Z`).toISOString();

const defaultScope = (): Scope => ({
  // A named toolkit grant needs discovery to let a machine enumerate the
  // exact frozen tools before invoking one. Users can opt out when they have
  // a separate, pre-known invocation path.
  scopes: ["discover", "invoke"],
  toolkitIds: [],
});

const maxExpiryDate = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.slice(0, 10);

const proofTypeForAdapter = (adapter: string): string =>
  adapter.endsWith("-api-key") ? "api-key" : adapter.endsWith("-access") ? "access" : adapter;

const connectionModeForScope = (scope: Scope): ConnectionMode =>
  scope.connectionIds === undefined
    ? "toolkit"
    : scope.connectionIds.length === 0
      ? "none"
      : "selected";

const failureMessage = (exit: Exit.Exit<unknown, unknown>, fallback: string): string => {
  if (Exit.isSuccess(exit)) return fallback;
  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
  const message = error === null ? null : Option.getOrNull(decodeFailureMessage(error))?.message;
  if (message !== undefined && message !== null) return message;
  return fallback;
};

const useDelegationScopeOptions = (target: "self" | string) => {
  const result = useAtomValue(delegationScopeOptionsAtom(target));
  return {
    options: AsyncResult.isSuccess(result) ? (result.value as ScopeOptions) : null,
    loading: isAsyncResultLoading(result),
  };
};

function ScopeFields(props: {
  readonly scope: Scope;
  readonly options: ScopeOptions | null;
  readonly loading: boolean;
  readonly onChange: (scope: Scope) => void;
}) {
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() =>
    connectionModeForScope(props.scope),
  );
  const toggle = (scope: Scope["scopes"][number]) => {
    const scopes = props.scope.scopes.includes(scope)
      ? props.scope.scopes.filter((value) => value !== scope)
      : [...props.scope.scopes, scope];
    props.onChange({ ...props.scope, scopes });
  };
  return (
    <div className="grid gap-3">
      <Label className="text-sm font-medium text-foreground">Consent scope</Label>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {(["discover", "invoke"] as const).map((scope) => (
          <Label key={scope} className="text-muted-foreground">
            <Input
              type="checkbox"
              className="size-4 w-auto"
              checked={props.scope.scopes.includes(scope)}
              onChange={() => toggle(scope)}
            />
            {scope}
          </Label>
        ))}
      </div>
      <div className="grid gap-2">
        <Label>Toolkits</Label>
        {props.loading && (
          <p className="text-xs text-muted-foreground">Loading available toolkits…</p>
        )}
        {!props.loading && props.options === null && (
          <p className="text-xs text-destructive">
            Scope choices are unavailable for this verified target. Try again before consenting.
          </p>
        )}
        {props.options && props.options.toolkits.length === 0 && (
          <p className="text-xs text-muted-foreground">No verified toolkit access is available.</p>
        )}
        {props.options?.toolkits.map((toolkit) => (
          <Label key={toolkit.id} className="text-sm text-muted-foreground">
            <Input
              type="checkbox"
              className="size-4 w-auto"
              checked={props.scope.toolkitIds.includes(toolkit.id)}
              onChange={() =>
                props.onChange({
                  ...props.scope,
                  toolkitIds: props.scope.toolkitIds.includes(toolkit.id)
                    ? props.scope.toolkitIds.filter((value) => value !== toolkit.id)
                    : [...props.scope.toolkitIds, toolkit.id],
                })
              }
            />
            <span>
              {toolkit.name} <span className="font-mono text-xs">({toolkit.slug})</span>
            </span>
          </Label>
        ))}
        <p className="text-xs text-muted-foreground">
          An empty toolkit list denies every tool. Membership is frozen at consent.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="delegation-connection-mode">Connection access</Label>
        <NativeSelect
          id="delegation-connection-mode"
          value={connectionMode}
          onChange={(event) => {
            const mode = event.target.value;
            if (mode === "toolkit") {
              setConnectionMode(mode);
              props.onChange({ ...props.scope, connectionIds: undefined });
            } else if (mode === "none") {
              setConnectionMode(mode);
              props.onChange({ ...props.scope, connectionIds: [] });
            } else if (mode === "selected") {
              setConnectionMode(mode);
              props.onChange({ ...props.scope, connectionIds: props.scope.connectionIds ?? [] });
            }
          }}
        >
          <NativeSelectOption value="toolkit">Frozen toolkit membership</NativeSelectOption>
          <NativeSelectOption value="none">Deny all connections</NativeSelectOption>
          <NativeSelectOption value="selected">Allow selected connections</NativeSelectOption>
        </NativeSelect>
        {connectionMode === "selected" && (
          <div className="grid gap-2 rounded-md border border-border p-3">
            {props.options?.connections.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No verified connections are available.
              </p>
            )}
            {props.options?.connections.map((connection) => (
              <Label key={connection.id} className="text-sm text-muted-foreground">
                <Input
                  type="checkbox"
                  className="size-4 w-auto"
                  checked={props.scope.connectionIds?.includes(connection.id) ?? false}
                  onChange={() => {
                    const selected = props.scope.connectionIds ?? [];
                    props.onChange({
                      ...props.scope,
                      connectionIds: selected.includes(connection.id)
                        ? selected.filter((value) => value !== connection.id)
                        : [...selected, connection.id],
                    });
                  }}
                />
                <span>
                  {connection.label}
                  {connection.description ? (
                    <span className="ml-1 text-xs">— {connection.description}</span>
                  ) : null}
                </span>
              </Label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          An explicit empty list denies every connection; omitted uses the frozen toolkit set.
        </p>
      </div>
    </div>
  );
}

function TargetSelect(props: {
  readonly targets: readonly Target[];
  readonly value: "self" | string;
  readonly onChange: (value: "self" | string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="delegation-target">Verified human target</Label>
      <NativeSelect
        id="delegation-target"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <NativeSelectOption value="self">My account</NativeSelectOption>
        {props.targets.map((target) => (
          <NativeSelectOption key={target.id} value={target.id}>
            {target.email}
            {target.name ? ` — ${target.name}` : ""}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

function CredentialRow(props: {
  readonly credential: Credential;
  readonly onRevoke: (credential: Credential) => void;
  readonly onRotate: (credential: Credential) => void;
  readonly rotating: boolean;
}) {
  const credential = props.credential;
  return (
    <div className="grid gap-3 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{credential.label}</p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {credential.reference.kind === "external"
            ? `${credential.reference.adapter}: ${credential.reference.reference}`
            : credential.reference.prefix}
        </p>
      </div>
      <div className="text-sm text-muted-foreground">
        <p>{credential.target.email}</p>
        <p className="text-xs">{credential.lifecycle.status}</p>
      </div>
      <div className="text-sm text-muted-foreground">
        <p>{credential.scope.scopes.join(", ") || "No operations"}</p>
        <p className="text-xs">
          expires {new Date(credential.lifecycle.expiresAt).toLocaleDateString()}
        </p>
        {credential.notification && (
          <p className="text-xs">notification: {credential.notification.status}</p>
        )}
      </div>
      <div className="flex justify-end gap-1">
        {credential.supportsRotation && credential.lifecycle.status === "active" && (
          <Button
            variant="ghost"
            size="sm"
            loading={props.rotating}
            onClick={() => props.onRotate(credential)}
          >
            Rotate
          </Button>
        )}
        {credential.lifecycle.status === "active" && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => props.onRevoke(credential)}
          >
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targets: readonly Target[];
  readonly onCreate: (body: typeof CreateDelegatedKeyBody.Type) => Promise<string | null>;
}) {
  const [label, setLabel] = useState("Delegated key");
  const [target, setTarget] = useState<"self" | string>("self");
  const [scope, setScope] = useState(defaultScope);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [value, setValue] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const scopeOptions = useDelegationScopeOptions(target);

  const submit = async () => {
    if (
      !label.trim() ||
      scope.scopes.length === 0 ||
      scopeOptions.options === null ||
      scopeOptions.loading ||
      creating
    )
      return;
    setCreating(true);
    const created = await props.onCreate({
      label: label.trim(),
      target: target === "self" ? { kind: "self" } : { kind: "verified-human", id: target },
      scope,
      expiresAt: expiryTimestamp(expiresAt),
    });
    setCreating(false);
    if (created) setValue(created);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Create delegated key</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Copy this secret now. It will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <Input value={value} readOnly className="font-mono text-xs" data-ph-mask />
              <CopyButton value={value} />
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="delegation-label">Label</Label>
              <Input
                id="delegation-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <TargetSelect targets={props.targets} value={target} onChange={setTarget} />
            <div className="grid gap-1.5">
              <Label htmlFor="delegation-expiry">Expires</Label>
              <Input
                id="delegation-expiry"
                type="date"
                value={expiresAt}
                max={maxExpiryDate(scopeOptions.options?.maxExpiresAt)}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </div>
            <ScopeFields
              key={props.open ? "open" : "closed"}
              scope={scope}
              options={scopeOptions.options}
              loading={scopeOptions.loading}
              onChange={setScope}
            />
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
          {!value && (
            <Button
              onClick={() => void submit()}
              loading={creating}
              disabled={!label.trim() || scopeOptions.loading || scopeOptions.options === null}
            >
              Create key
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChallengeDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targets: readonly Target[];
  readonly adapters: readonly string[];
  readonly challenge: Challenge | null;
  readonly onStart: (body: {
    readonly adapter: string;
    readonly label: string;
    readonly target:
      | { readonly kind: "self" }
      | { readonly kind: "verified-human"; readonly id: string };
    readonly scope: Scope;
    readonly expiresAt: string;
  }) => Promise<Challenge | null>;
  readonly onConsent: (
    challenge: Challenge,
    body: typeof ConsentDelegationBody.Type,
  ) => Promise<void>;
}) {
  const [label, setLabel] = useState("External delegated credential");
  const [adapter, setAdapter] = useState(props.adapters[0] ?? "");
  const [target, setTarget] = useState<"self" | string>("self");
  const [scope, setScope] = useState(defaultScope);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [starting, setStarting] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [proofNonce, setProofNonce] = useState<string | null>(null);
  const scopeOptions = useDelegationScopeOptions(target);
  const refreshChallenge = useAtomRefresh(delegationChallengeAtom(props.challenge?.id ?? ""));

  useEffect(() => {
    if (!props.open || props.challenge?.status !== "awaiting-proof") setProofNonce(null);
  }, [props.challenge?.status, props.open]);

  useEffect(() => {
    if (!props.open || props.challenge?.status !== "awaiting-proof") return;
    const interval = setInterval(() => refreshChallenge(), 1_000);
    return () => clearInterval(interval);
  }, [props.challenge?.id, props.challenge?.status, props.open, refreshChallenge]);

  const start = async () => {
    if (
      !adapter ||
      !label.trim() ||
      scopeOptions.options === null ||
      scopeOptions.loading ||
      starting
    )
      return;
    setStarting(true);
    const started = await props.onStart({
      adapter,
      label: label.trim(),
      target: target === "self" ? { kind: "self" } : { kind: "verified-human", id: target },
      scope,
      expiresAt: expiryTimestamp(expiresAt),
    });
    if (started) setProofNonce(started.nonce);
    setStarting(false);
  };

  const consent = async () => {
    if (!props.challenge || consenting) return;
    setConsenting(true);
    await props.onConsent(props.challenge, { scope, expiresAt: expiryTimestamp(expiresAt) });
    setConsenting(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Connect external credential</DialogTitle>
        </DialogHeader>
        {props.challenge ? (
          <div className="grid gap-4">
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Proof status: {props.challenge.status}</p>
              <p className="mt-1 text-muted-foreground">Challenge {props.challenge.id}</p>
              {props.challenge.provenCredential && (
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  Proven:{" "}
                  {props.challenge.provenCredential.kind === "external"
                    ? `${props.challenge.provenCredential.adapter}: ${props.challenge.provenCredential.reference}`
                    : props.challenge.provenCredential.prefix}
                </p>
              )}
            </div>
            {props.challenge.status === "awaiting-proof" && proofNonce !== null && (
              <div className="grid gap-3 rounded-md border border-border p-3">
                <p className="text-sm text-muted-foreground">
                  Using the machine's own credential, POST this JSON to the endpoint below. The
                  nonce is shown only while this challenge is open.
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="delegation-proof-endpoint">Proof endpoint</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="delegation-proof-endpoint"
                      value={`/api/account/delegated-credentials/challenges/${props.challenge.id}/proof`}
                      readOnly
                      className="font-mono text-xs"
                    />
                    <CopyButton
                      value={`/api/account/delegated-credentials/challenges/${props.challenge.id}/proof`}
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="delegation-proof-payload">Proof payload</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="delegation-proof-payload"
                      value={JSON.stringify({
                        nonce: proofNonce,
                        proofType: proofTypeForAdapter(props.challenge.adapter),
                      })}
                      readOnly
                      className="font-mono text-xs"
                      data-ph-mask
                    />
                    <CopyButton
                      value={JSON.stringify({
                        nonce: proofNonce,
                        proofType: proofTypeForAdapter(props.challenge.adapter),
                      })}
                    />
                  </div>
                </div>
              </div>
            )}
            {props.challenge.instructions && (
              <p className="text-sm text-muted-foreground">{props.challenge.instructions}</p>
            )}
            <ScopeFields
              key={props.open ? "open" : "closed"}
              scope={scope}
              options={scopeOptions.options}
              loading={scopeOptions.loading}
              onChange={setScope}
            />
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="delegation-adapter">Adapter</Label>
              <NativeSelect
                id="delegation-adapter"
                value={adapter}
                onChange={(event) => setAdapter(event.target.value)}
              >
                {props.adapters.map((item) => (
                  <NativeSelectOption key={item} value={item}>
                    {item}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="external-delegation-label">Label</Label>
              <Input
                id="external-delegation-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <TargetSelect targets={props.targets} value={target} onChange={setTarget} />
            <div className="grid gap-1.5">
              <Label htmlFor="external-delegation-expiry">Expires</Label>
              <Input
                id="external-delegation-expiry"
                type="date"
                value={expiresAt}
                max={maxExpiryDate(scopeOptions.options?.maxExpiresAt)}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </div>
            <ScopeFields
              key={props.open ? "open" : "closed"}
              scope={scope}
              options={scopeOptions.options}
              loading={scopeOptions.loading}
              onChange={setScope}
            />
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
          {!props.challenge ? (
            <Button
              onClick={() => void start()}
              loading={starting}
              disabled={
                !adapter || !label.trim() || scopeOptions.loading || scopeOptions.options === null
              }
            >
              Start challenge
            </Button>
          ) : props.challenge.status === "proof-complete" ? (
            <Button onClick={() => void consent()} loading={consenting}>
              Give final consent
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DelegatedCredentialsPage() {
  useExecutorDocumentTitle("Delegated credentials");
  const credentials = useAtomValue(delegatedCredentialsOptimisticAtom);
  const targets = useAtomValue(delegationTargetsAtom);
  const audit = useAtomValue(delegationAuditAtom);
  const notifications = useAtomValue(delegationNotificationsAtom);
  const refreshCredentials = useAtomRefresh(delegatedCredentialsOptimisticAtom);
  const refreshAudit = useAtomRefresh(delegationAuditAtom);
  const refreshNotifications = useAtomRefresh(delegationNotificationsAtom);
  const doCreate = useAtomSet(createDelegatedKey, { mode: "promiseExit" });
  const doStartChallenge = useAtomSet(startDelegationChallenge, { mode: "promiseExit" });
  const doConsentChallenge = useAtomSet(consentDelegationChallenge, { mode: "promiseExit" });
  const doMarkNotificationRead = useAtomSet(markDelegationNotificationRead, {
    mode: "promiseExit",
  });
  const doRotate = useAtomSet(rotateDelegatedKey, { mode: "promiseExit" });
  const doRevoke = useAtomSet(revokeDelegatedCredentialOptimistic, { mode: "promiseExit" });
  const doRevokeAll = useAtomSet(revokeAllDelegatedCredentialsOptimistic, { mode: "promiseExit" });
  const [createOpen, setCreateOpen] = useState(false);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [challengeId, setChallengeId] = useState("");
  const challengeResult = useAtomValue(delegationChallengeAtom(challengeId));
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [targetFilter, setTargetFilter] = useState("all");
  const [disableTarget, setDisableTarget] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const response: CredentialsResponse | null = AsyncResult.isSuccess(credentials)
    ? credentials.value
    : null;
  const targetRows: readonly Target[] = AsyncResult.isSuccess(targets)
    ? targets.value.targets.filter((target) => target.status === "verified")
    : [];
  const challenge: Challenge | null =
    AsyncResult.isSuccess(challengeResult) && challengeResult.value !== null
      ? challengeResult.value
      : null;
  const visibleCredentials =
    response?.credentials.filter(
      (credential) => targetFilter === "all" || credential.target.id === targetFilter,
    ) ?? [];
  const cloudMfaAvailable =
    response?.capabilities.externalAdapters.includes("workos-api-key") ?? false;

  const create = async (body: typeof CreateDelegatedKeyBody.Type): Promise<string | null> => {
    setActionError(null);
    const exit = await doCreate({ payload: body, reactivityKeys: delegatedCredentialWriteKeys });
    if (Exit.isFailure(exit)) {
      setActionError(failureMessage(exit, "The delegated key could not be created."));
      return null;
    }
    refreshCredentials();
    return exit.value.value;
  };

  const start = async (body: {
    readonly adapter: string;
    readonly label: string;
    readonly target:
      | { readonly kind: "self" }
      | { readonly kind: "verified-human"; readonly id: string };
    readonly scope: Scope;
    readonly expiresAt: string;
  }): Promise<Challenge | null> => {
    setActionError(null);
    const exit = await doStartChallenge({
      payload: body,
      reactivityKeys: delegatedCredentialWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setActionError(failureMessage(exit, "The external challenge could not be started."));
      return null;
    }
    setChallengeId(exit.value.id);
    return exit.value;
  };

  const consent = async (current: Challenge, body: typeof ConsentDelegationBody.Type) => {
    setActionError(null);
    const exit = await doConsentChallenge({
      params: { challengeId: current.id },
      payload: body,
      reactivityKeys: delegatedCredentialWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      refreshCredentials();
      setChallengeId("");
      setChallengeOpen(false);
    } else {
      setActionError(failureMessage(exit, "The external credential could not be approved."));
    }
  };

  const rotate = async (credential: Credential) => {
    if (rotatingId) return;
    setActionError(null);
    setRotatingId(credential.id);
    const exit = await doRotate({
      params: { credentialId: credential.id },
      reactivityKeys: delegatedCredentialWriteKeys,
    });
    setRotatingId(null);
    if (Exit.isSuccess(exit)) {
      setRotatedSecret(exit.value.value);
      refreshCredentials();
    } else {
      setActionError(failureMessage(exit, "The delegated key could not be rotated."));
    }
  };

  const revoke = async (credential: Credential) => {
    if (!window.confirm(`Revoke ${credential.label}?`)) return;
    setActionError(null);
    const exit = await doRevoke({
      params: { credentialId: credential.id },
      reactivityKeys: delegatedCredentialWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setActionError(failureMessage(exit, "The delegated credential could not be revoked."));
      return;
    }
    refreshCredentials();
    refreshAudit();
  };

  const revokeAll = async () => {
    const target =
      response?.capabilities.canFilterTargets && targetFilter !== "all"
        ? { kind: "verified-human" as const, id: targetFilter }
        : { kind: "self" as const };
    if (
      !window.confirm(
        target.kind === "self"
          ? "Revoke all delegated credentials for your account?"
          : "Revoke all delegated credentials for this target?",
      )
    )
      return;
    setActionError(null);
    const exit = await doRevokeAll({
      payload: {
        target,
        ...(disableTarget && target.kind === "verified-human" ? { disableTarget: true } : {}),
      },
      reactivityKeys: delegatedCredentialWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setActionError(failureMessage(exit, "The delegated credentials could not be revoked."));
      return;
    }
    refreshCredentials();
    refreshAudit();
  };

  const markNotificationRead = async (notificationId: string) => {
    const exit = await doMarkNotificationRead({
      params: { notificationId },
      reactivityKeys: delegatedCredentialWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setActionError(failureMessage(exit, "The notification could not be marked read."));
      return;
    }
    refreshNotifications();
  };

  return (
    <PageContainer>
      <PageHeader
        title="Delegated credentials"
        description="Issue narrowly scoped credentials for verified people and review external machine proof before granting access."
        actions={
          response?.capabilities.issuanceEnabled &&
          (response.capabilities.localKeysEnabled ||
            response.capabilities.externalAdapters.length > 0) ? (
            <div className="flex gap-2">
              {response.capabilities.localKeysEnabled && (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Create local key
                </Button>
              )}
              {response.capabilities.externalAdapters.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => setChallengeOpen(true)}>
                  External challenge
                </Button>
              )}
            </div>
          ) : null
        }
      />

      {response && !response.capabilities.issuanceEnabled && (
        <div className="mb-6 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Delegated credential issuance is disabled by this host administrator.
        </div>
      )}
      {response?.capabilities.issuanceEnabled && (
        <div className="mb-6 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
          <p className="font-medium text-foreground">
            Fresh verification is required to issue access.
          </p>
          <p className="mt-1 text-muted-foreground">
            Sign in again or complete the verification your host requires before creating,
            expanding, or rotating a credential.
            {cloudMfaAvailable && (
              <>
                {" "}
                <a className="font-medium text-foreground underline" href="../org">
                  Verify MFA in Organization settings
                </a>
                .
              </>
            )}
          </p>
        </div>
      )}
      {actionError && (
        <div className="mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <p role="alert" className="text-destructive">
            {actionError}
          </p>
          <p className="mt-1 text-muted-foreground">
            If verification is required, sign in again or complete your host&apos;s verification,
            then try again.
            {cloudMfaAvailable && (
              <>
                {" "}
                <a className="font-medium text-foreground underline" href="../org">
                  Verify MFA in Organization settings
                </a>
                .
              </>
            )}
          </p>
        </div>
      )}
      {!response && isAsyncResultLoading(credentials) && (
        <p className="text-sm text-muted-foreground">Loading delegated credentials…</p>
      )}
      {AsyncResult.isFailure(credentials) && (
        <ErrorState message="Delegated credentials are unavailable." onRetry={refreshCredentials} />
      )}
      {response && (
        <div className="grid gap-3">
          {rotatedSecret && (
            <div className="grid gap-2 rounded-md border border-amber-300/50 bg-amber-50/50 px-4 py-3 dark:bg-amber-950/20">
              <p className="text-sm font-medium">Your rotated secret is shown once.</p>
              <div className="flex items-center gap-2">
                <Input value={rotatedSecret} readOnly className="font-mono text-xs" data-ph-mask />
                <CopyButton value={rotatedSecret} />
                <Button variant="ghost" size="sm" onClick={() => setRotatedSecret(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Credentials ({visibleCredentials.length})
            </p>
            {response.capabilities.canFilterTargets && (
              <NativeSelect
                aria-label="Filter delegated credentials by target"
                size="sm"
                className="text-xs"
                value={targetFilter}
                onChange={(event) => {
                  setTargetFilter(event.target.value);
                  setDisableTarget(false);
                }}
              >
                <NativeSelectOption value="all">All targets</NativeSelectOption>
                {targetRows.map((target) => (
                  <NativeSelectOption key={target.id} value={target.id}>
                    {target.email}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-border bg-card">
            {visibleCredentials.length === 0 ? (
              <p className="px-4 py-8 text-sm text-muted-foreground">
                No delegated credentials for this filter.
              </p>
            ) : (
              visibleCredentials.map((credential) => (
                <CredentialRow
                  key={credential.id}
                  credential={credential}
                  rotating={rotatingId === credential.id}
                  onRevoke={(item) => void revoke(item)}
                  onRotate={(item) => void rotate(item)}
                />
              ))
            )}
          </div>
        </div>
      )}

      <section className="mt-10">
        {AsyncResult.isSuccess(notifications) && notifications.value.notifications.length > 0 && (
          <div className="mb-8">
            <h2 className="font-display text-xl text-foreground">Notifications</h2>
            <div className="mt-3 grid gap-2">
              {notifications.value.notifications.map((notification) => (
                <div
                  key={notification.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{notification.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{notification.message}</p>
                  </div>
                  {!notification.readAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void markNotificationRead(notification.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl text-foreground">Your grants</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Revoke every credential acting for your account.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void revokeAll()}>
            Revoke all
          </Button>
        </div>
        {response?.capabilities.canFilterTargets && targetFilter !== "all" && (
          <Label className="mb-4 flex items-start gap-2 text-sm text-muted-foreground">
            <Input
              type="checkbox"
              className="mt-0.5 size-4 w-auto"
              checked={disableTarget}
              onChange={(event) => setDisableTarget(event.target.checked)}
            />
            <span>
              Block future delegations for this target
              <span className="mt-1 block text-xs">
                Revokes current credentials and disables this verified human until an administrator
                restores access.
              </span>
            </span>
          </Label>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl text-foreground">Audit</h2>
        <div className="mt-3 overflow-hidden rounded-md border border-border bg-card">
          {AsyncResult.isSuccess(audit) && audit.value.events.length > 0 ? (
            audit.value.events.map((event) => (
              <div
                key={event.id}
                className="grid gap-1 border-b border-border px-4 py-3 text-sm last:border-b-0 md:grid-cols-[1fr_1fr_auto]"
              >
                <span>{event.action}</span>
                <span className="text-muted-foreground">{event.outcome}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(event.occurredAt).toLocaleString()}
                </span>
              </div>
            ))
          ) : (
            <p className="px-4 py-6 text-sm text-muted-foreground">No audit events yet.</p>
          )}
        </div>
      </section>

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        targets={targetRows}
        onCreate={create}
      />
      <ChallengeDialog
        open={challengeOpen}
        onOpenChange={(open) => {
          setChallengeOpen(open);
          if (!open) setChallengeId("");
        }}
        targets={targetRows}
        adapters={response?.capabilities.externalAdapters ?? []}
        challenge={challenge}
        onStart={start}
        onConsent={consent}
      />
    </PageContainer>
  );
}
