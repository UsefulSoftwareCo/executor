import { useEffect, useMemo, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  type Owner,
} from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";
import { toast } from "sonner";

import {
  addConnectionOptimistic,
  probeOAuth,
  providerItemsAtom,
  providersAtom,
  registerDynamicOAuthClient,
  startOAuth,
} from "../api/atoms";
import { connectionWriteKeys, oauthClientWriteKeys } from "../api/reactivity-keys";
import { messageFromExit } from "../api/error-reporting";
import { useOrganizationId } from "../api/organization-context";
import { ownerLabel, ownerLabelForHost, useOwnerDisplay } from "../api/owner-display";
import {
  ConnectionOwnerDropdown,
  connectionOwnerOptionsForHost,
  defaultConnectionOwnerForHost,
  normalizeConnectionOwner,
  resolveOAuthConnectionOwnerForHost,
  type ConnectionOwnerOption,
} from "../plugins/connection-owner";
import { oauthCallbackUrl, useOAuthPopupFlow } from "../plugins/oauth-sign-in";
import {
  clientDisplayName,
  clientHost,
  uniqueClientSlug,
  useOAuthClientsForIntegration,
  type OAuthClientOption,
} from "../plugins/use-effective-oauth-client";
import { cn } from "../lib/utils";
import { OAuthClientForm } from "./oauth-client-form";
import { AddCustomMethodForm, type CreateCustomMethod } from "./add-custom-method-modal";
import { PlacementLine, type AuthMethod } from "../lib/auth-placements";
import { connectionIdentifier } from "../lib/connection-name";
import { Badge } from "./badge";
import { Button } from "./button";
import { PlusIcon, XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

// ---------------------------------------------------------------------------
// Add-account modal — the connection-create form.
//
// Field order: (1) display name · (2) authentication method · (3) credential
// · (4) saved-to owner. A connection is immutable once created. Step 2 collects
// one value per distinct input the method declares — usually one, but a
// multi-input method (e.g. Datadog's two keys) shows one field per variable.
//
// OAuth: step 2 lists the registered apps usable for this integration and lets
// you PICK one (or "Register a new app"). While registering, name/saved-to are
// hidden (they don't apply yet). Once an app is selected, the footer's "Connect
// with OAuth" mints the connection with the name + saved-to. The CLIENT owner
// (whose app) is distinct from the CONNECTION's saved-to owner.
// ---------------------------------------------------------------------------

const ONEPASSWORD_PROVIDER = ProviderKey.make("onepassword");

type CredentialOrigin = "paste" | "onepassword";
type CredentialInput = { readonly variable: string; readonly label: string };

type CredentialPayloadOrigin =
  | { readonly values: Record<string, string> }
  | {
      readonly from: {
        readonly provider: ProviderKey;
        readonly id: ProviderItemId;
      };
    };

export function createCredentialPayloadOrigin(args: {
  readonly origin: CredentialOrigin;
  readonly inputs: readonly CredentialInput[];
  readonly values: Readonly<Record<string, string>>;
  readonly onePasswordItemId: string;
  readonly singleInput: boolean;
}): CredentialPayloadOrigin | null {
  if (args.inputs.length === 0) return { values: { token: "" } };
  if (args.origin === "onepassword") {
    const id = args.onePasswordItemId.trim();
    if (!args.singleInput || id.length === 0) return null;
    return {
      from: { provider: ONEPASSWORD_PROVIDER, id: ProviderItemId.make(id) },
    };
  }

  const values = Object.fromEntries(
    args.inputs.map((input) => [input.variable, (args.values[input.variable] ?? "").trim()]),
  );
  return Object.values(values).every((value) => value.length > 0) ? { values } : null;
}

const numberBadge = (n: number) => (
  <span className="inline-grid size-[18px] shrink-0 place-items-center rounded-full border border-border bg-muted text-[11px] text-muted-foreground">
    {n}
  </span>
);

function isOnePasswordRegistered(
  providers: AsyncResult.AsyncResult<readonly ProviderKey[], unknown>,
) {
  return AsyncResult.match(providers, {
    onInitial: () => false,
    onFailure: () => false,
    onSuccess: ({ value }) =>
      value.some((provider: ProviderKey) => String(provider) === String(ONEPASSWORD_PROVIDER)),
  });
}

function PasteCredentialInputs(props: {
  readonly inputs: readonly CredentialInput[];
  readonly singleInput: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-2">
      {props.inputs.map((input) => (
        <div key={input.variable} className="space-y-1">
          {!props.singleInput && (
            <Label className="text-xs text-muted-foreground">{input.label}</Label>
          )}
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={props.singleInput ? "paste the value / token" : `paste ${input.label}`}
            value={props.values[input.variable] ?? ""}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              props.onChange({
                ...props.values,
                [input.variable]: e.target.value,
              })
            }
            className="font-mono"
            data-ph-block
          />
        </div>
      ))}
    </div>
  );
}

function OnePasswordItemSelect(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const itemsResult = useAtomValue(providerItemsAtom(ONEPASSWORD_PROVIDER));
  const state = AsyncResult.matchWithError(
    itemsResult as AsyncResult.AsyncResult<
      readonly { readonly id: ProviderItemId; readonly name: string }[],
      Error
    >,
    {
      onInitial: () => ({
        items: [] as readonly {
          readonly id: ProviderItemId;
          readonly name: string;
        }[],
        loading: true,
        error: null as string | null,
      }),
      onError: () => ({
        items: [] as readonly {
          readonly id: ProviderItemId;
          readonly name: string;
        }[],
        loading: false,
        error: "Failed to load 1Password items",
      }),
      onDefect: () => ({
        items: [] as readonly {
          readonly id: ProviderItemId;
          readonly name: string;
        }[],
        loading: false,
        error: "Failed to load 1Password items",
      }),
      onSuccess: ({ value }) => ({ items: value, loading: false, error: null }),
    },
  );

  if (state.loading) {
    return <p className="text-xs text-muted-foreground">Loading 1Password items…</p>;
  }
  if (state.error) {
    return <p className="text-xs text-destructive">{state.error}</p>;
  }
  if (state.items.length === 0) {
    return <p className="text-xs text-muted-foreground">No 1Password items found.</p>;
  }

  return (
    <div className="space-y-1" data-ph-block>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select secret" />
        </SelectTrigger>
        <SelectContent>
          {state.items.map((item) => (
            <SelectItem key={String(item.id)} value={String(item.id)}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CredentialValueFields(props: {
  readonly inputs: readonly CredentialInput[];
  readonly singleInput: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly onValuesChange: (values: Record<string, string>) => void;
  readonly origin: CredentialOrigin;
  readonly onOriginChange: (origin: CredentialOrigin) => void;
  readonly onePasswordItemId: string;
  readonly onOnePasswordItemIdChange: (value: string) => void;
}) {
  const providers = useAtomValue(providersAtom);
  const onePasswordAvailable = props.singleInput && isOnePasswordRegistered(providers);

  return (
    <div className="space-y-3">
      {onePasswordAvailable ? (
        <RadioGroup
          value={props.origin}
          onValueChange={(value) => props.onOriginChange(value as CredentialOrigin)}
          className="grid grid-cols-2 gap-2"
        >
          <Label
            htmlFor="credential-origin-paste"
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm font-normal has-[:checked]:border-ring has-[:checked]:bg-accent/40"
          >
            <RadioGroupItem id="credential-origin-paste" value="paste" />
            Paste value
          </Label>
          <Label
            htmlFor="credential-origin-onepassword"
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm font-normal has-[:checked]:border-ring has-[:checked]:bg-accent/40"
          >
            <RadioGroupItem id="credential-origin-onepassword" value="onepassword" />
            1Password
          </Label>
        </RadioGroup>
      ) : null}

      {onePasswordAvailable && props.origin === "onepassword" ? (
        <OnePasswordItemSelect
          value={props.onePasswordItemId}
          onChange={props.onOnePasswordItemIdChange}
        />
      ) : (
        <PasteCredentialInputs
          inputs={props.inputs}
          singleInput={props.singleInput}
          values={props.values}
          onChange={props.onValuesChange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step header — the label introducing each section of the form. Four style
// variants are kept for design review; flip STEP_HEADER_VARIANT to preview each
// one in isolation. The numbered-circle treatment implied a sequential wizard
// the form isn't (every section shows at once), so the alternatives drop the
// numbers.
//   - "numbered": numbered circle + label + inline hint (current).
//   - "eyebrow":  uppercase micro-caps, hint on its own line. Matches the app's
//                 existing section headers (e.g. AccountsSection).
//   - "sentence": plain form label in foreground weight, hint inline.
//   - "accent":   a short leading rule for rhythm without implied sequence.
// ---------------------------------------------------------------------------
type StepHeaderVariant = "numbered" | "eyebrow" | "sentence" | "accent";

/** Swap this to preview each step-header style. */
const STEP_HEADER_VARIANT: StepHeaderVariant = "eyebrow";

function StepHeader(props: {
  readonly index: number;
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
}) {
  const { index, label, hint, htmlFor } = props;

  const variants: Record<StepHeaderVariant, React.ReactElement> = {
    numbered: (
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {numberBadge(index)}
        {label}
        {hint ? <span className="font-normal text-muted-foreground/70">{hint}</span> : null}
      </Label>
    ),
    eyebrow: (
      <div className="flex flex-col gap-1">
        <Label
          htmlFor={htmlFor}
          className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {label}
        </Label>
        {hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
      </div>
    ),
    sentence: (
      <Label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
        {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </Label>
    ),
    accent: (
      <Label htmlFor={htmlFor} className="gap-2.5 text-xs text-muted-foreground">
        <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="font-normal text-muted-foreground/70">{hint}</span> : null}
      </Label>
    ),
  };

  return variants[STEP_HEADER_VARIANT];
}

/** Derive the connection's display label from the user's free-text name (or a
 *  default of "<owner> <integration>"). With an empty `label` this yields the
 *  derived name shown as the name input's placeholder, so the optional-but-
 *  prefilled intent is visible. */
export const connectionLabel = (label: string, owner: Owner, integrationName: string): string =>
  label.trim() || `${ownerLabel(owner)} ${integrationName}`;

export const connectionLabelForHost = (
  label: string,
  owner: Owner,
  integrationName: string,
  organizationId: string | null,
): string => label.trim() || `${ownerLabelForHost(owner, organizationId)} ${integrationName}`;

/** The default owner a new connection is saved under when the user makes no
 *  explicit choice. Personal: a connection is most often a personal credential. */
export const DEFAULT_CONNECTION_OWNER: Owner = "user";

const authMethodKey = (method: AuthMethod): string =>
  method.source === "custom" ? `custom:${String(method.template)}` : `declared:${method.id}`;

/** The selectable methods: the declared catalog methods plus any custom method
 *  created in this session, deduped by stable method identity (custom appended
 *  last). A just-created method shows + can be selected before the catalog
 *  refresh lands. */
export const mergeCustomMethods = (
  declared: readonly AuthMethod[],
  created: readonly AuthMethod[],
): readonly AuthMethod[] => {
  const keys = new Set(declared.map(authMethodKey));
  return [...declared, ...created.filter((method: AuthMethod) => !keys.has(authMethodKey(method)))];
};

/** Derive a stable JS-identifier-safe callable connection name from the label. */
export const connectionNameFrom = (
  label: string,
  owner: Owner,
  integrationName: string,
  organizationId: string | null,
): ConnectionName =>
  connectionIdentifier(connectionLabelForHost(label, owner, integrationName, organizationId));

// ---------------------------------------------------------------------------
// Transparent DCR (RFC 7591) connect orchestration.
//
// For DCR-capable methods (MCP OAuth) the user clicks one "Connect" button and
// we do everything: probe the integration's discovery URL → register a client
// against the advertised registration endpoint → start
// the OAuth flow with the minted client. No app picker, no pasted client id.
//
// This is extracted as a pure-ish orchestrator (injected `probe`/`register`/
// `start`) so the SEQUENCE is unit-testable without React/atoms. The caller
// supplies thin adapters over the `probeOAuth` / `registerDynamicOAuthClient` /
// popup-start atoms.
// ---------------------------------------------------------------------------

/** Discovery result from the probe step (subset of the `probeOAuth` response). */
type DcrProbeResult = {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly scopesSupported?: readonly string[];
  readonly registrationEndpoint?: string | null;
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
};

type DcrRegisterArgs = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly registrationEndpoint: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly scopes: readonly string[];
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
  readonly clientName: string;
  readonly redirectUri?: string;
  readonly originIntegration?: IntegrationSlug;
};

type DcrStartArgs = {
  readonly client: OAuthClientSlug;
  readonly owner: Owner;
};

/** Outcome of the DCR orchestration. `"started"` means the OAuth flow handed
 *  off (the popup/inline start ran); `"fallback"` means we could not auto-set-up
 *  (probe failed, or no registration endpoint) and the caller should fall back
 *  to the bring-your-own-app picker. */
type DcrOutcome =
  | { readonly kind: "started" }
  | {
      readonly kind: "fallback";
      readonly reason: "probe-failed" | "no-registration-endpoint";
    };

type RunDcrConnectDeps = {
  /** Probe the discovery URL → resolved endpoints + (maybe) a registration
   *  endpoint. Resolves to null when the probe fails. */
  readonly probe: (url: string) => Promise<DcrProbeResult | null>;
  /** Register a DCR client → the minted client slug, or null on failure. */
  readonly register: (args: DcrRegisterArgs) => Promise<OAuthClientSlug | null>;
  /** Start the OAuth flow with the minted client (popup / inline). */
  readonly start: (args: DcrStartArgs) => void;
};

type RunDcrConnectInput = {
  readonly discoveryUrl: string;
  readonly owner: Owner;
  readonly integrationName: string;
  /** The owner's existing client slugs, so the minted slug stays unique. */
  readonly existingSlugs: readonly string[];
  /** Scopes declared by the integration's method (override the probed ones). */
  readonly declaredScopes?: readonly string[];
  /** Browser-facing callback URL registered with DCR when available. */
  readonly redirectUri?: string;
  /** Integration that requested this DCR client. */
  readonly integration: IntegrationSlug;
};

/**
 * Run the transparent DCR connect sequence: probe → register → start.
 *
 * - Probe failure → `{ kind: "fallback", reason: "probe-failed" }` (caller shows BYO).
 * - No registration endpoint → `{ kind: "fallback", reason: "no-registration-endpoint" }`.
 * - Register failure → throws via the injected `register` rejecting; the caller
 *   treats a thrown/rejected register as fallback (kept out of the happy path).
 * - Success → registers, calls `start`, returns `{ kind: "started" }`.
 */
export async function runDcrConnect(
  deps: RunDcrConnectDeps,
  input: RunDcrConnectInput,
): Promise<DcrOutcome> {
  const probe = await deps.probe(input.discoveryUrl);
  if (probe === null) return { kind: "fallback", reason: "probe-failed" };
  const registrationEndpoint = probe.registrationEndpoint;
  if (!registrationEndpoint) return { kind: "fallback", reason: "no-registration-endpoint" };

  const slug = uniqueClientSlug(input.integrationName, input.existingSlugs);
  const scopes =
    input.declaredScopes && input.declaredScopes.length > 0
      ? input.declaredScopes
      : (probe.scopesSupported ?? []);
  const minted = await deps.register({
    owner: input.owner,
    slug,
    registrationEndpoint,
    authorizationUrl: probe.authorizationUrl,
    tokenUrl: probe.tokenUrl,
    resource: probe.resource ?? null,
    scopes,
    tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
    clientName: input.integrationName,
    redirectUri: input.redirectUri,
    originIntegration: input.integration,
  });
  if (minted === null) return { kind: "fallback", reason: "probe-failed" };
  deps.start({ client: minted, owner: input.owner });
  return { kind: "started" };
}

export function AddAccountModal(props: {
  readonly integration: IntegrationSlug;
  readonly integrationName: string;
  readonly methods: readonly AuthMethod[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialState?: IntegrationAccountHandoff | null;
  /** When provided, the modal shows a "+ Custom method" row that opens the
   *  apiKey custom-method editor. The plugin binds this to its own template
   *  converter + configure mutation (react never imports a plugin package). A
   *  plugin whose auth is fixed (MCP) omits this, hiding the row. */
  readonly createCustomMethod?: CreateCustomMethod;
  readonly removeCustomMethod?: (method: AuthMethod) => Promise<boolean>;
}) {
  const {
    integration,
    integrationName,
    methods,
    open,
    onOpenChange,
    initialState,
    createCustomMethod,
    removeCustomMethod,
  } = props;
  const organizationId = useOrganizationId();
  const ownerDisplay = useOwnerDisplay();
  const ownerOptions = useMemo(
    () => connectionOwnerOptionsForHost(organizationId),
    [organizationId],
  );
  const defaultOwner = defaultConnectionOwnerForHost(organizationId);

  // The selectable methods: the declared ones plus any custom method created in
  // this session (so a just-created method shows + can be selected before the
  // catalog refresh lands via `integrationWriteKeys`). Deduped by id, custom
  // last.
  const [createdMethods, setCreatedMethods] = useState<readonly AuthMethod[]>([]);
  const [removedMethodIds, setRemovedMethodIds] = useState<ReadonlySet<string>>(() => new Set());
  const allMethods = useMemo<readonly AuthMethod[]>(
    () =>
      mergeCustomMethods(
        methods.filter((method: AuthMethod) => !removedMethodIds.has(authMethodKey(method))),
        createdMethods.filter((method: AuthMethod) => !removedMethodIds.has(authMethodKey(method))),
      ),
    [methods, createdMethods, removedMethodIds],
  );
  const [addingMethod, setAddingMethod] = useState(false);

  const [methodId, setMethodId] = useState<string>(methods[0]?.id ?? "");
  // One value per distinct credential input (`variable → pasted value`). A
  // single-secret method has just `{ token }`; a method with two distinct inputs
  // (e.g. Datadog's two keys) collects one value per variable.
  const [values, setValues] = useState<Record<string, string>>({});
  const [credentialOrigin, setCredentialOrigin] = useState<CredentialOrigin>("paste");
  const [onePasswordItemId, setOnePasswordItemId] = useState("");
  const [label, setLabel] = useState("");
  // Explicit create-time choice (no ambient owner). Cloud defaults to Personal;
  // local/desktop hide the picker and save to the one local workspace.
  const [owner, setOwner] = useState<Owner>(defaultOwner);
  const [submitting, setSubmitting] = useState(false);
  const [pickedApp, setPickedApp] = useState<string | null>(null);
  const [registeringOAuthClient, setRegisteringOAuthClient] = useState(false);
  const [ccBusy, setCcBusy] = useState(false);
  // Transparent DCR: busy while probing/registering/starting; `dcrFailed` flips
  // the modal to the bring-your-own-app picker if auto setup is unavailable.
  const [dcrBusy, setDcrBusy] = useState(false);
  const [dcrFailed, setDcrFailed] = useState(false);
  // FIX 3 escape hatch: when no registered app matched the integration's
  // endpoints, the unmatched apps are collapsed behind an opt-in expander.
  const [showOtherApps, setShowOtherApps] = useState(false);

  const doCreate = useAtomSet(addConnectionOptimistic(owner), {
    mode: "promiseExit",
  });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doProbe = useAtomSet(probeOAuth, { mode: "promiseExit" });
  const doRegisterDynamic = useAtomSet(registerDynamicOAuthClient, {
    mode: "promiseExit",
  });

  const method = useMemo(
    () => allMethods.find((m: AuthMethod) => m.id === methodId) ?? allMethods[0],
    [allMethods, methodId],
  );

  useEffect(() => {
    if (allMethods.length === 0) {
      if (methodId !== "") setMethodId("");
      return;
    }
    if (allMethods.some((m: AuthMethod) => m.id === methodId)) return;
    setMethodId(allMethods[0]!.id);
  }, [allMethods, methodId]);

  useEffect(() => {
    if (!initialState) return;
    const initialMethod = initialState.template
      ? allMethods.find(
          (m: AuthMethod) =>
            m.id === initialState.template || String(m.template) === initialState.template,
        )
      : undefined;
    if (initialMethod) setMethodId(initialMethod.id);
    setOwner(normalizeConnectionOwner(initialState.owner ?? defaultOwner, ownerOptions));
    if (initialState.label) setLabel(initialState.label);
    setValues({});
    setCredentialOrigin("paste");
    setOnePasswordItemId("");
    setPickedApp(null);
    setDcrFailed(false);
  }, [initialState, allMethods, defaultOwner, ownerOptions]);

  useEffect(() => {
    if (allMethods.length === 0) return;
    if (allMethods.some((m: AuthMethod) => m.id === methodId)) return;
    const initialMethod = initialState?.template
      ? allMethods.find(
          (m: AuthMethod) =>
            m.id === initialState.template || String(m.template) === initialState.template,
        )
      : undefined;
    setMethodId(initialMethod?.id ?? allMethods[0]!.id);
  }, [allMethods, initialState?.template, methodId]);

  const isOAuth = method?.kind === "oauth";
  const isNoAuth = method?.kind === "none";
  // The distinct credential inputs the selected method needs — one per variable
  // across its placements. A single-input method yields one field (`token`); a
  // multi-input method (e.g. Datadog) yields one per key. Two placements sharing
  // a variable collapse to one input.
  const credentialInputs = useMemo<readonly CredentialInput[]>(() => {
    if (!method || method.kind === "oauth" || method.kind === "none") return [];
    const byVar = new Map<string, string[]>();
    for (const placement of method.placements) {
      const variable = placement.variable ?? "token";
      const names = byVar.get(variable) ?? [];
      names.push(placement.name || (placement.carrier === "header" ? "header" : "query param"));
      byVar.set(variable, names);
    }
    if (byVar.size === 0) return [{ variable: "token", label: "Value" }];
    return [...byVar.entries()].map(([variable, names]) => ({
      variable,
      label: names.join(" / "),
    }));
  }, [method]);
  const singleInput = credentialInputs.length <= 1;
  // DCR-capable: the integration advertises dynamic registration (MCP oauth2),
  // OR carries a discovery URL we can probe at connect time. When DCR-capable
  // and not yet fallen back, we skip the app picker entirely (Option A).
  const isDcr =
    isOAuth &&
    (method?.oauth?.supportsDynamicRegistration === true || method?.oauth?.discoveryUrl != null);
  const dcrActive = isDcr && !dcrFailed;

  // OAuth apps usable for this integration (user-owned first). Hooks run
  // unconditionally; in DCR mode the result is ignored until/unless we fall back.
  const {
    clients: oauthApps,
    otherClients: oauthOtherApps,
    loading: oauthLoading,
    endpointMatched: oauthEndpointMatched,
    displayRegisterCTA: oauthDisplayRegisterCTA,
  } = useOAuthClientsForIntegration({
    tokenUrl: method?.oauth?.tokenUrl,
    authorizationUrl: method?.oauth?.authorizationUrl,
  });
  const oauthPopup = useOAuthPopupFlow({
    popupName: "add-account-oauth",
    detectPopupClosed: false,
    startErrorMessage: "Failed to start OAuth",
  });

  // Default to the first app ONLY when the apps are endpoint-matched; when they
  // are not (host filter matched nothing), leave the selection empty so the
  // user must explicitly register or choose a possibly-mismatched app.
  const oauthDefaultApp =
    oauthEndpointMatched && oauthApps.length > 0 ? String(oauthApps[0]?.slug) : "";
  const selectedApp = pickedApp ?? oauthDefaultApp;
  const oauthRegistering = isOAuth && registeringOAuthClient;
  const chosenClient: OAuthClientOption | null =
    oauthApps.find((c: OAuthClientOption) => String(c.slug) === selectedApp) ?? null;
  const oauthBusy = ccBusy || oauthPopup.busy;
  const dcrConnecting = dcrBusy || oauthPopup.busy;

  // "Connection saved to" for a PICKED BYO OAuth app. Cloud: a Workspace (`org`)
  // app can mint Personal or Workspace connections; a Personal (`user`) app can
  // only mint Personal. Local/desktop: every path clamps back to Local (`org`).
  const oauthSharedApp = chosenClient?.owner === "org";
  const oauthConnectionOptions = useMemo(
    () =>
      oauthSharedApp
        ? ownerOptions
        : ownerOptions.filter((o: ConnectionOwnerOption) => o.owner === "user"),
    [oauthSharedApp, ownerOptions],
  );
  const oauthConnectionOwner: Owner = resolveOAuthConnectionOwnerForHost({
    organizationId,
    requestedOwner: owner,
    clientOwner: chosenClient?.owner ?? "user",
  });
  const savedToOptions = isOAuth && !dcrActive ? oauthConnectionOptions : ownerOptions;
  const savedToOwner = isOAuth && !dcrActive ? oauthConnectionOwner : owner;
  const showSavedToPicker = !oauthRegistering && savedToOptions.length > 1;
  const callableName = connectionNameFrom(label, savedToOwner, integrationName, organizationId);

  const reset = () => {
    setMethodId(methods[0]?.id ?? "");
    setValues({});
    setCredentialOrigin("paste");
    setOnePasswordItemId("");
    setLabel("");
    setOwner(defaultOwner);
    setSubmitting(false);
    setPickedApp(null);
    setRegisteringOAuthClient(false);
    setCcBusy(false);
    setDcrBusy(false);
    setDcrFailed(false);
    setShowOtherApps(false);
    setCreatedMethods([]);
    setRemovedMethodIds(new Set());
    setAddingMethod(false);
  };

  const selectMethod = (nextMethodId: string): void => {
    setMethodId(nextMethodId);
    setValues({});
    setCredentialOrigin("paste");
    setOnePasswordItemId("");
  };

  // A just-created custom method joins the in-session list and is auto-selected
  // so the user can immediately add an account with it. The catalog refresh
  // (via the plugin's `integrationWriteKeys`) reconciles it shortly after.
  const handleCustomMethodCreated = (created: AuthMethod): void => {
    setCreatedMethods((current: readonly AuthMethod[]) => [
      ...current.filter((m: AuthMethod) => m.id !== created.id),
      created,
    ]);
    setRemovedMethodIds((current: ReadonlySet<string>) => {
      const next = new Set(current);
      next.delete(authMethodKey(created));
      return next;
    });
    selectMethod(created.id);
    setAddingMethod(false);
  };

  const handleRemoveCustomMethod = async (methodToRemove: AuthMethod): Promise<void> => {
    if (!removeCustomMethod) return;
    const removed = await removeCustomMethod(methodToRemove);
    if (!removed) return;
    setCreatedMethods((current: readonly AuthMethod[]) =>
      current.filter((m: AuthMethod) => authMethodKey(m) !== authMethodKey(methodToRemove)),
    );
    setRemovedMethodIds((current: ReadonlySet<string>) =>
      new Set(current).add(authMethodKey(methodToRemove)),
    );
    if (methodId === methodToRemove.id) {
      const next = allMethods.find((m: AuthMethod) => m.id !== methodToRemove.id);
      selectMethod(next?.id ?? "");
    }
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  const credentialPayloadOrigin = createCredentialPayloadOrigin({
    origin: credentialOrigin,
    inputs: credentialInputs,
    values,
    onePasswordItemId,
    singleInput,
  });

  const canSubmit = method != null && !submitting && credentialPayloadOrigin !== null;

  const handleSubmit = async () => {
    const payloadOrigin = createCredentialPayloadOrigin({
      origin: credentialOrigin,
      inputs: credentialInputs,
      values,
      onePasswordItemId,
      singleInput,
    });
    if (!method || !canSubmit || payloadOrigin === null) return;
    setSubmitting(true);
    const commonPayload = {
      owner,
      name: connectionNameFrom(label, owner, integrationName, organizationId),
      integration,
      template: method.template,
      identityLabel: connectionLabelForHost(label, owner, integrationName, organizationId),
    };
    const exit = await doCreate({
      payload:
        "from" in payloadOrigin
          ? { ...commonPayload, from: payloadOrigin.from }
          : { ...commonPayload, values: payloadOrigin.values },
      reactivityKeys: connectionWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setSubmitting(false);
      toast.error(messageFromExit(exit, "Failed to add connection"));
      return;
    }
    toast.success("Connection added");
    close();
  };

  const handleOAuthConnect = async () => {
    if (!method || !chosenClient) return;
    // The connection is minted under the user-picked "saved to" owner, NOT the
    // app's owner: a Workspace (shared) app can mint a Personal connection. The
    // backend resolves the app own→shared from the slug, so the payload carries
    // only the host-resolved connection owner.
    const connectionOwner = oauthConnectionOwner;
    const payload = {
      client: chosenClient.slug,
      clientOwner: chosenClient.owner,
      owner: connectionOwner,
      name: connectionNameFrom(label, connectionOwner, integrationName, organizationId),
      integration,
      template: method.template,
      identityLabel: connectionLabelForHost(
        label,
        connectionOwner,
        integrationName,
        organizationId,
      ),
    };
    // client_credentials mints inline (no redirect); authorization_code runs the popup.
    if (chosenClient.grant === "client_credentials") {
      setCcBusy(true);
      const exit = await doStartOAuth({
        payload,
        reactivityKeys: connectionWriteKeys,
      });
      setCcBusy(false);
      if (Exit.isFailure(exit)) {
        toast.error(messageFromExit(exit, "Failed to connect"));
        return;
      }
      toast.success("Connection added");
      close();
      return;
    }
    void oauthPopup.start({
      payload,
      onSuccess: () => {
        toast.success("Connection added");
        close();
      },
    });
  };

  // Transparent DCR connect: probe → register → start, no app picker. On any
  // failure (probe error or no registration endpoint) we flip `dcrFailed` so the
  // bring-your-own-app picker renders as the recovery path with name/owner kept.
  const handleDcrConnect = async () => {
    const discoveryUrl = method?.oauth?.discoveryUrl ?? method?.oauth?.tokenUrl;
    if (!method || !discoveryUrl) {
      setDcrFailed(true);
      return;
    }
    const dcrOwner = owner;
    const connectionName = connectionNameFrom(label, dcrOwner, integrationName, organizationId);
    const identityLabel = connectionLabelForHost(label, dcrOwner, integrationName, organizationId);
    setDcrBusy(true);
    const outcome = await runDcrConnect(
      {
        probe: async (url: string): Promise<DcrProbeResult | null> => {
          const exit = await doProbe({ payload: { url }, reactivityKeys: [] });
          if (Exit.isFailure(exit)) return null;
          return exit.value;
        },
        register: async (args: DcrRegisterArgs): Promise<OAuthClientSlug | null> => {
          const exit = await doRegisterDynamic({
            payload: {
              owner: args.owner,
              slug: args.slug,
              registrationEndpoint: args.registrationEndpoint,
              authorizationUrl: args.authorizationUrl,
              tokenUrl: args.tokenUrl,
              resource: args.resource ?? null,
              scopes: args.scopes,
              tokenEndpointAuthMethodsSupported: args.tokenEndpointAuthMethodsSupported,
              clientName: args.clientName,
              redirectUri: args.redirectUri,
              originIntegration: args.originIntegration,
            },
            reactivityKeys: oauthClientWriteKeys,
          });
          if (Exit.isFailure(exit)) return null;
          return exit.value.client;
        },
        start: (args: DcrStartArgs): void => {
          void oauthPopup.start({
            payload: {
              client: args.client,
              // DCR registers the client under the connection owner, so the app
              // and connection share one owner.
              clientOwner: args.owner,
              owner: args.owner,
              name: connectionName,
              integration,
              template: method.template,
              identityLabel,
            },
            onSuccess: () => {
              toast.success("Connection added");
              close();
            },
          });
        },
      },
      {
        discoveryUrl,
        owner: dcrOwner,
        integrationName,
        existingSlugs: [...oauthApps, ...oauthOtherApps].map((app: OAuthClientOption) =>
          String(app.slug),
        ),
        declaredScopes: method.oauth?.scopes,
        redirectUri: oauthCallbackUrl(),
        integration,
      },
    );
    setDcrBusy(false);
    if (outcome.kind === "fallback") {
      setDcrFailed(true);
      toast.error("Automatic setup unavailable — register an app");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent
        className={cn(
          "max-h-[85vh] overflow-x-hidden overflow-y-auto",
          (addingMethod && createCustomMethod) || oauthRegistering
            ? "gap-0 p-0 sm:max-w-2xl"
            : "sm:max-w-xl",
        )}
      >
        {addingMethod && createCustomMethod ? (
          <>
            <DialogHeader className="border-b border-border/60 px-5 py-4">
              <DialogTitle className="text-base">Add authentication method</DialogTitle>
              <DialogDescription className="text-sm">
                Define how {integrationName} receives an API key.
              </DialogDescription>
            </DialogHeader>
            <AddCustomMethodForm
              onCreate={createCustomMethod}
              onCreated={handleCustomMethodCreated}
              onCancel={() => setAddingMethod(false)}
            />
          </>
        ) : oauthRegistering && method?.kind === "oauth" ? (
          <>
            <DialogHeader className="border-b border-border/60 px-5 py-4">
              <DialogTitle className="text-base">Register OAuth app</DialogTitle>
              <DialogDescription className="text-sm">
                Add a client for {integrationName}, then select it for this connection.
              </DialogDescription>
            </DialogHeader>
            <div className="px-5 py-5">
              <OAuthClientForm
                integrationName={integrationName}
                existingSlugs={[...oauthApps, ...oauthOtherApps].map((app: OAuthClientOption) =>
                  String(app.slug),
                )}
                prefill={{
                  authorizationUrl: method.oauth?.authorizationUrl,
                  tokenUrl: method.oauth?.tokenUrl,
                  scopes: method.oauth?.scopes,
                  registrationEndpoint: method.oauth?.registrationEndpoint,
                }}
                onCreated={(result: { readonly owner: Owner; readonly slug: OAuthClientSlug }) => {
                  setPickedApp(String(result.slug));
                  setRegisteringOAuthClient(false);
                }}
                onCancel={() => setRegisteringOAuthClient(false)}
                surface="plain"
              />
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add connection · {integrationName}</DialogTitle>
              <DialogDescription>
                {ownerDisplay.showOwnerLabels
                  ? "A connection is a saved way to use this integration, owned by you or the workspace."
                  : "A connection is a saved way to use this integration."}
              </DialogDescription>
            </DialogHeader>

            <div className="flex w-full min-w-0 flex-col gap-5">
              <div className="space-y-2">
                <StepHeader
                  index={1}
                  label="Display name"
                  hint="how you'll tell accounts apart"
                  htmlFor="connection-name"
                />
                <Input
                  id="connection-name"
                  placeholder={connectionLabelForHost("", owner, integrationName, organizationId)}
                  value={label}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This connection will be callable as{" "}
                  <span className="font-mono text-foreground">{String(callableName)}</span>.
                </p>
              </div>

              {(!dcrActive || createCustomMethod) && (
                <Tabs
                  value={methodId}
                  onValueChange={selectMethod}
                  className="w-full min-w-0 max-w-full gap-3"
                >
                  <TabsList className="flex h-10 w-fit min-w-0 max-w-full justify-start overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:thin]">
                    <div className="flex w-max shrink-0 items-stretch gap-1">
                      {allMethods.map((m: AuthMethod) => (
                        <div
                          key={m.id}
                          className="group/method-tab relative flex h-8 shrink-0 items-stretch"
                        >
                          <TabsTrigger
                            value={m.id}
                            className={cn(
                              "h-full max-w-64 shrink-0 justify-start px-3 text-sm font-medium",
                              m.source === "custom" && removeCustomMethod ? "pr-8" : null,
                            )}
                          >
                            <span className="truncate">{m.label}</span>
                          </TabsTrigger>
                          {m.source === "custom" && removeCustomMethod ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${m.label}`}
                              tabIndex={methodId === m.id ? 0 : -1}
                              className={cn(
                                "absolute right-1 top-1/2 z-10 size-6 -translate-y-1/2 rounded-full text-muted-foreground transition-opacity hover:bg-transparent hover:text-destructive",
                                methodId === m.id ? "opacity-100" : "pointer-events-none opacity-0",
                              )}
                              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleRemoveCustomMethod(m);
                              }}
                            >
                              <XIcon />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                      {createCustomMethod && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Add authentication method"
                          className="h-8 shrink-0 rounded-md border border-transparent bg-transparent px-3 text-foreground/60 hover:bg-background/60 hover:text-foreground dark:hover:bg-input/30"
                          onClick={() => setAddingMethod(true)}
                        >
                          <PlusIcon className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TabsList>

                  {dcrActive ? null : (
                    <TabsContent
                      value={methodId}
                      className="mt-0 min-w-0 space-y-5 rounded-md border border-border/60 bg-muted/15 p-4"
                    >
                      {method?.placements && method.placements.length > 0 ? (
                        <div className="flex flex-wrap gap-x-3.5 gap-y-1">
                          {method.placements.map((placement, i: number) => (
                            <PlacementLine key={i} placement={placement} />
                          ))}
                        </div>
                      ) : null}

                      {!isNoAuth && (
                        <div className="space-y-2">
                          <StepHeader index={2} label={isOAuth ? "OAuth app" : "Credential"} />

                          {isOAuth && method ? (
                            dcrActive ? (
                              // Transparent DCR: no picker. We register an app for you and run
                              // the OAuth flow with a single Connect click.
                              <div className="space-y-2 rounded-lg border border-ring/40 bg-accent/30 px-3 py-3">
                                <p className="text-sm font-medium">No app to choose</p>
                                <p className="text-xs text-muted-foreground">
                                  {dcrConnecting
                                    ? `Connecting to ${integrationName}…`
                                    : `${integrationName} supports automatic setup. We register an app for you and sign you in — no client ID or app to pick.`}
                                </p>
                              </div>
                            ) : oauthLoading ? (
                              <p className="text-xs text-muted-foreground">Loading OAuth apps…</p>
                            ) : (
                              <div className="space-y-3">
                                {/* No registered app matched the integration's endpoint:
                        empty state + a prominent register CTA, and an opt-in
                        collapsed "use a different registered app" escape hatch. */}
                                {oauthDisplayRegisterCTA && (
                                  <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                                    <p className="text-sm font-medium">
                                      No app for {integrationName} yet
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      None of your registered apps target this integration's OAuth
                                      endpoint. Register one to connect.
                                    </p>
                                    <div className="flex flex-wrap items-center gap-2 pt-1">
                                      <Button
                                        type="button"
                                        size="sm"
                                        onClick={() => setRegisteringOAuthClient(true)}
                                      >
                                        Register app
                                      </Button>
                                      {oauthOtherApps.length > 0 && !showOtherApps ? (
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={() => setShowOtherApps(true)}
                                        >
                                          Use another app
                                        </Button>
                                      ) : null}
                                    </div>
                                    {oauthOtherApps.length > 0 && showOtherApps ? (
                                      <RadioGroup
                                        value={selectedApp}
                                        onValueChange={setPickedApp}
                                        className="gap-2 pt-1"
                                      >
                                        {oauthOtherApps.map((app: OAuthClientOption) => (
                                          <Label
                                            key={String(app.slug)}
                                            htmlFor={`other-app-${app.slug}`}
                                            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5 font-normal has-[:checked]:border-ring has-[:checked]:bg-accent/40"
                                          >
                                            <RadioGroupItem
                                              id={`other-app-${app.slug}`}
                                              value={String(app.slug)}
                                            />
                                            <span className="min-w-0 flex-1">
                                              <span className="block text-sm font-medium">
                                                {clientDisplayName(String(app.slug))}
                                              </span>
                                              <span className="block truncate text-xs text-muted-foreground">
                                                {clientHost(app.tokenUrl)} ·{" "}
                                                {app.grant === "client_credentials"
                                                  ? "app-to-app"
                                                  : "you'll sign in"}
                                              </span>
                                            </span>
                                            {ownerDisplay.showOwnerLabels ? (
                                              <Badge variant="outline">
                                                {ownerLabel(app.owner)}
                                              </Badge>
                                            ) : null}
                                          </Label>
                                        ))}
                                      </RadioGroup>
                                    ) : null}
                                  </div>
                                )}

                                {oauthApps.length > 0 && (
                                  <RadioGroup
                                    value={selectedApp}
                                    onValueChange={setPickedApp}
                                    className="gap-2"
                                  >
                                    {oauthApps.map((app: OAuthClientOption) => (
                                      <Label
                                        key={String(app.slug)}
                                        htmlFor={`app-${app.slug}`}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 font-normal has-[:checked]:border-ring has-[:checked]:bg-accent/40"
                                      >
                                        <RadioGroupItem
                                          id={`app-${app.slug}`}
                                          value={String(app.slug)}
                                        />
                                        <span className="min-w-0 flex-1">
                                          <span className="block text-sm font-medium">
                                            {clientDisplayName(String(app.slug))}
                                          </span>
                                          <span className="block truncate text-xs text-muted-foreground">
                                            {clientHost(app.tokenUrl)} ·{" "}
                                            {app.grant === "client_credentials"
                                              ? "app-to-app"
                                              : "you'll sign in"}
                                          </span>
                                        </span>
                                        {ownerDisplay.showOwnerLabels ? (
                                          <Badge variant="outline">{ownerLabel(app.owner)}</Badge>
                                        ) : null}
                                      </Label>
                                    ))}
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className="h-auto justify-start gap-3 rounded-lg border-dashed border-border/60 px-3 py-2.5 text-sm font-normal text-muted-foreground hover:text-foreground"
                                      onClick={() => setRegisteringOAuthClient(true)}
                                    >
                                      <PlusIcon className="size-4" />
                                      Register a new app
                                    </Button>
                                  </RadioGroup>
                                )}
                              </div>
                            )
                          ) : (
                            <CredentialValueFields
                              inputs={credentialInputs}
                              singleInput={singleInput}
                              values={values}
                              onValuesChange={setValues}
                              origin={credentialOrigin}
                              onOriginChange={(next) => {
                                setCredentialOrigin(next);
                                if (next === "paste") setOnePasswordItemId("");
                              }}
                              onePasswordItemId={onePasswordItemId}
                              onOnePasswordItemIdChange={setOnePasswordItemId}
                            />
                          )}
                          {isOAuth && oauthPopup.error ? (
                            <p className="text-xs text-destructive">{oauthPopup.error}</p>
                          ) : null}
                        </div>
                      )}
                    </TabsContent>
                  )}
                </Tabs>
              )}

              {/* Connection saved-to. Hidden while registering a new OAuth app
              (the connection, and where it's saved, only exists once you
              connect). Pickable everywhere else: for a PICKED OAuth app a
              Workspace (shared) app can mint a Personal OR Workspace connection,
              while a Personal app mints Personal only in cloud;
              for transparent DCR the app + connection land under the chosen
              owner; for a credential method it's the plain owner choice. */}
              {showSavedToPicker && (
                <div className="space-y-2">
                  <StepHeader index={3} label="Connection saved to" />
                  <ConnectionOwnerDropdown
                    value={savedToOwner}
                    options={savedToOptions}
                    onChange={(next: Owner) => setOwner(next)}
                    label="Saved to"
                  />
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={close}
                disabled={submitting || oauthBusy || dcrConnecting}
              >
                {isOAuth ? "Close" : "Cancel"}
              </Button>
              {/* Footer action, in precedence order:
              - transparent DCR (no picker): a single Connect that runs
                probe → register → start;
              - registering a BYO app: the form owns its own submit, no footer;
              - picked BYO OAuth app: Connect with OAuth / Connect (client creds);
              - credential/no-auth method: Add connection. */}
              {dcrActive ? (
                <Button
                  type="button"
                  onClick={() => void handleDcrConnect()}
                  disabled={dcrConnecting}
                >
                  {dcrConnecting ? "Connecting…" : "Connect"}
                </Button>
              ) : oauthRegistering ? null : isOAuth ? (
                <Button
                  type="button"
                  onClick={() => void handleOAuthConnect()}
                  disabled={chosenClient === null || oauthBusy}
                >
                  {oauthBusy
                    ? "Connecting…"
                    : chosenClient?.grant === "client_credentials"
                      ? "Connect"
                      : "Connect with OAuth"}
                </Button>
              ) : (
                <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
                  {submitting ? "Adding…" : "Add connection"}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
