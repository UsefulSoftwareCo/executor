import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  identityPathTier,
  rankResponseSample,
  type HealthCheckCandidate,
  type HealthCheckResult,
  type HealthCheckSpec,
  type OAuthClientSummary,
  type Owner,
} from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";
import { toast } from "sonner";

import {
  addConnectionOptimistic,
  checkConnectionHealth,
  connectionsAllAtom,
  createOAuthClientOptimistic,
  integrationHealthCheckAtom,
  integrationHealthCheckCandidatesAtom,
  oauthClientsOptimisticAtom,
  probeOAuth,
  providerItemsAtom,
  providersAtom,
  registerDynamicOAuthClient,
  removeOAuthClientOptimistic,
  setIntegrationHealthCheck,
  startOAuth,
  updateConnection,
  validateConnection,
} from "../api/atoms";
import {
  connectionCheckKeys,
  connectionWriteKeys,
  healthCheckWriteKeys,
  oauthClientWriteKeys,
} from "../api/reactivity-keys";
import { HEALTH_INDICATOR_COLOR, HEALTH_STATUS_LABEL } from "../lib/health-display";
import { FreeformCombobox, type FreeformComboboxOption } from "./combobox";
import { messageFromExit } from "../api/error-reporting";
import { trackEvent } from "../api/analytics";
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
import {
  oauthCallbackUrl,
  oauthClientIdMetadataDocumentUrl,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "../plugins/oauth-sign-in";
import {
  clientDisplayName,
  clientHost,
  optimisticDcrClientSlug,
  selectDcrClientsForIntegration,
  uniqueClientSlug,
  useOAuthClientsForIntegration,
  type OAuthClientOption,
} from "../plugins/use-effective-oauth-client";
import { cn } from "../lib/utils";
import { buildUsageMap, connectionsUsingClient } from "../lib/oauth-client-usage";
import {
  OAuthClientForm,
  registrationScopes,
  type OAuthClientFormPrefill,
} from "./oauth-client-form";
import { RemoveOAuthAppDialog } from "./remove-oauth-app-dialog";
import { AddCustomMethodForm, type CreateCustomMethod } from "./add-custom-method-modal";
import { PlacementLine, type AuthMethod } from "../lib/auth-placements";
import { connectionIdentifier } from "../lib/connection-name";
import { Badge } from "./badge";
import { Button } from "./button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { ChevronDown, EyeIcon, EyeOffIcon, PlusIcon, XIcon } from "lucide-react";
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

/** Constant-label reveal control (aria-pressed carries the state, per the
 *  screen-reader guidance against relabeling toggles). Masked keys make typos
 *  invisible; every credential field pairs with one of these. */
function RevealKeyButton(props: { readonly revealed: boolean; readonly onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Show key"
      aria-pressed={props.revealed}
      className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      onClick={props.onToggle}
    >
      {props.revealed ? <EyeOffIcon /> : <EyeIcon />}
    </Button>
  );
}

function PasteCredentialInputs(props: {
  readonly inputs: readonly CredentialInput[];
  readonly singleInput: boolean;
  /** Force the per-input label even for a single input (env vars name their
   *  field rather than relying on a generic "value / token" placeholder). */
  readonly showLabels?: boolean;
  /** Single-input only: the placement's lead + prefix (e.g. "Authorization:
   *  Bearer "), rendered as a non-editable affix INSIDE the field so the input
   *  reads as the header value being built. Replaces the separate preview line. */
  readonly affix?: string | null;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Record<string, string>) => void;
}) {
  // One reveal state for the whole group: a user checking their paste wants
  // to see all of it, not toggle per field.
  const [revealed, setRevealed] = useState(false);
  const inputType = revealed ? "text" : "password";
  if (!props.singleInput) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {props.inputs.map((input) => (
          <div key={input.variable} className="min-w-0 space-y-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <Label
                htmlFor={`credential-input-${input.variable}`}
                className="min-w-0 truncate font-mono text-xs font-medium text-muted-foreground"
              >
                {input.label}
              </Label>
            </div>
            <div className="flex items-center gap-1">
              <Input
                id={`credential-input-${input.variable}`}
                type={inputType}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                value={props.values[input.variable] ?? ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  props.onChange({
                    ...props.values,
                    [input.variable]: e.target.value,
                  })
                }
                className="h-9 font-mono text-sm"
                data-ph-block
              />
              <RevealKeyButton revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Past the multi-input grid above, singleInput is always true, so labelled
  // reduces to showLabels: env vars opt in to naming their single field.
  const labelled = props.showLabels ?? false;
  return (
    <div className="space-y-2">
      {props.inputs.map((input) => (
        <div key={input.variable} className="space-y-1">
          {labelled && (
            <Label className="font-mono text-xs text-muted-foreground">{input.label}</Label>
          )}
          {props.affix ? (
            // Merged field: the placement's lead + prefix is a FIXED addon (its
            // own muted segment, divider, non-selectable), and the user types
            // only the token after it — the field reads as the header value being
            // built. Only the border reacts to focus (no full-field glow). The
            // autoComplete/ignore attrs stop the browser and password managers
            // from offering to GENERATE a password here; the app's own 1Password
            // picker covers filling an existing secret.
            <div className="flex h-9 w-full min-w-0 items-stretch overflow-hidden rounded-md border border-input bg-transparent font-mono text-sm shadow-xs transition-colors focus-within:border-ring dark:bg-input/30">
              <span className="flex shrink-0 select-none items-center whitespace-pre border-r border-input bg-muted/40 px-3 text-muted-foreground/70">
                {props.affix}
              </span>
              {/* oxlint-disable-next-line react/forbid-elements */}
              <input
                type={inputType}
                autoComplete="off"
                // The key is the modal's real first input: the display name is
                // derived from it, so this is where typing starts.
                // oxlint-disable-next-line jsx_a11y/no-autofocus -- deliberate: the credential drives everything else in the form
                autoFocus
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                // No visible label or placeholder here (the affix carries the
                // instruction visually), so the accessible name comes from
                // aria-label instead, matching the multi-input grid's Label
                // text one-for-one.
                aria-label={input.label}
                value={props.values[input.variable] ?? ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  props.onChange({ ...props.values, [input.variable]: e.target.value })
                }
                className="min-w-0 flex-1 bg-transparent px-3 outline-none"
                data-ph-block
              />
              <RevealKeyButton revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Input
                type={inputType}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                // The Label above (when labelled) has no htmlFor, so it isn't
                // programmatically associated with this input; aria-label is
                // the only accessible name in either case.
                aria-label={input.label}
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
              <RevealKeyButton revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
            </div>
          )}
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
  readonly showLabels?: boolean;
  /** Single-input only: placement lead + prefix to merge into the field. */
  readonly affix?: string | null;
  /** Allow an external provider (1Password) origin. Off for env methods: the
   *  wire's external `from` is keyed under the canonical `token` variable, but
   *  an env credential must be keyed under its env var name, so a 1Password
   *  origin would persist the secret under the wrong key and the subprocess
   *  would launch without it. Paste stays correctly keyed per variable. */
  readonly allowExternalProvider?: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly onValuesChange: (values: Record<string, string>) => void;
  readonly origin: CredentialOrigin;
  readonly onOriginChange: (origin: CredentialOrigin) => void;
  readonly onePasswordItemId: string;
  readonly onOnePasswordItemIdChange: (value: string) => void;
}) {
  const providers = useAtomValue(providersAtom);
  const onePasswordAvailable =
    props.singleInput &&
    (props.allowExternalProvider ?? true) &&
    isOnePasswordRegistered(providers);

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
          showLabels={props.showLabels}
          affix={props.affix}
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

export const oauthIdentityLabelFromHealth = (input: {
  readonly result: HealthCheckResult;
  readonly typedLabel: string;
  readonly storedIdentityLabel?: string | null;
  readonly defaultIdentityLabel: string;
}): string | null => {
  const identity = input.result.identity?.trim();
  if (input.result.status !== "healthy" || !identity) return null;
  if (input.typedLabel.trim().length > 0) return null;
  const defaultLabel = input.defaultIdentityLabel.trim();
  const storedLabel = (input.storedIdentityLabel ?? defaultLabel).trim();
  return storedLabel === defaultLabel ? identity : null;
};

// ---------------------------------------------------------------------------
// Transparent CIMD connect orchestration.
//
// Client ID Metadata Document support is not Dynamic Client Registration:
// there is no POST to a registration endpoint and no provider-side app to pick.
// The OAuth client identity is this host's public metadata-document URL, stored
// locally as a public PKCE client (`clientSecret: ""`) so the existing
// `oauth.start` flow can run unchanged.
// ---------------------------------------------------------------------------

type CimdExistingClient = Pick<
  OAuthClientSummary,
  "owner" | "slug" | "grant" | "authorizationUrl" | "tokenUrl" | "resource" | "clientId"
>;

type CimdCreateClientArgs = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly grant: "authorization_code";
  readonly clientId: string;
  readonly clientSecret: "";
};

type RunCimdConnectDeps = {
  readonly createClient: (args: CimdCreateClientArgs) => Promise<OAuthClientSlug | null>;
  readonly start: (args: { readonly client: OAuthClientSlug; readonly owner: Owner }) => void;
};

type RunCimdConnectInput = {
  readonly owner: Owner;
  readonly integrationName: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly clientIdMetadataDocumentUrl: string;
  readonly existingClients: readonly CimdExistingClient[];
};

type CimdOutcome =
  | { readonly kind: "started"; readonly client: OAuthClientSlug; readonly reused: boolean }
  | { readonly kind: "failed"; readonly reason: "missing-endpoints" | "create-failed" };

export async function runCimdConnect(
  deps: RunCimdConnectDeps,
  input: RunCimdConnectInput,
): Promise<CimdOutcome> {
  if (input.authorizationUrl.trim().length === 0 || input.tokenUrl.trim().length === 0) {
    return { kind: "failed", reason: "missing-endpoints" };
  }

  const resource = input.resource ?? null;
  const existing = input.existingClients.find(
    (client) =>
      client.owner === input.owner &&
      client.grant === "authorization_code" &&
      client.authorizationUrl === input.authorizationUrl &&
      client.tokenUrl === input.tokenUrl &&
      (client.resource ?? null) === resource &&
      client.clientId === input.clientIdMetadataDocumentUrl,
  );

  if (existing) {
    deps.start({ client: existing.slug, owner: input.owner });
    return { kind: "started", client: existing.slug, reused: true };
  }

  const slug = uniqueClientSlug(
    `${input.integrationName} CIMD`,
    input.existingClients.map((client) => String(client.slug)),
  );
  const created = await deps.createClient({
    owner: input.owner,
    slug,
    authorizationUrl: input.authorizationUrl,
    tokenUrl: input.tokenUrl,
    resource,
    grant: "authorization_code",
    clientId: input.clientIdMetadataDocumentUrl,
    clientSecret: "",
  });
  if (created === null) return { kind: "failed", reason: "create-failed" };
  deps.start({ client: created, owner: input.owner });
  return { kind: "started", client: created, reused: false };
}

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
  readonly issuer?: string | null;
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
  readonly issuer?: string | null;
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
 *  — a failed probe, no registration endpoint, or a failed registration — and
 *  the caller should fall back to the bring-your-own-app picker. A failed probe
 *  carries no probe result; the other two reasons always carry the probe that
 *  seeds the picker. */
type DcrOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "fallback"; readonly reason: "probe-failed" }
  | {
      readonly kind: "fallback";
      readonly reason: "no-registration-endpoint" | "registration-failed";
      readonly probe: DcrProbeResult;
      /** A specific, user-facing reason to surface instead of the generic
       *  "register an app" copy (e.g. a server that rejects the DCR redirect
       *  URI). Absent when the fallback carries no actionable detail. */
      readonly message?: string;
    };

type RunDcrConnectDeps = {
  /** Probe the discovery URL → resolved endpoints + (maybe) a registration
   *  endpoint. Resolves to null when the probe fails. */
  readonly probe: (url: string) => Promise<DcrProbeResult | null>;
  /** Register a DCR client → the minted client slug, `{ error }` with a
   *  user-facing message when the server rejects registration, or null on an
   *  unexplained failure. */
  readonly register: (
    args: DcrRegisterArgs,
  ) => Promise<OAuthClientSlug | { readonly error: string } | null>;
  /** Start the OAuth flow with the minted client (popup / inline). */
  readonly start: (args: DcrStartArgs) => void;
};

type RunDcrConnectInput = {
  readonly discoveryUrl: string;
  /** The integration's genuine protected-resource URL (the MCP discovery URL),
   *  used as the RFC 8707 resource indicator when the server's PRM names no
   *  `resource`. Distinct from `discoveryUrl`, which falls back to the token
   *  endpoint for probing: the token endpoint is NOT a resource identifier, so
   *  it must never become the indicator. Undefined for integrations with no
   *  discovery URL (non-MCP DCR), collapsing the resource to null as before. */
  readonly resourceFallback?: string;
  readonly owner: Owner;
  readonly integrationName: string;
  /** Scopes declared by the integration's method (override the probed ones). */
  readonly declaredScopes?: readonly string[];
  /** Browser-facing callback URL registered with DCR when available. */
  readonly redirectUri?: string;
  /** Integration that requested this DCR client. */
  readonly integration: IntegrationSlug;
};

export const dcrClientNameForIntegration = (integrationName: string): string => {
  const trimmed = integrationName.trim();
  return trimmed.length > 0 ? `Executor for ${trimmed}` : "Executor";
};

/**
 * Run the transparent DCR connect sequence: probe → register → start.
 *
 * - Probe failure → `{ kind: "fallback", reason: "probe-failed" }` (caller shows BYO).
 * - No registration endpoint → `{ kind: "fallback", reason: "no-registration-endpoint", probe }`.
 * - Register rejected with a message → `{ kind: "fallback", reason: "registration-failed", probe, message }`
 *   so the caller can show why (e.g. a redirect-URI rejection) over the generic copy.
 * - Register failed without detail (null) → `{ kind: "fallback", reason: "registration-failed", probe }`.
 * - Success → registers, calls `start`, returns `{ kind: "started" }`.
 */
export async function runDcrConnect(
  deps: RunDcrConnectDeps,
  input: RunDcrConnectInput,
): Promise<DcrOutcome> {
  const probe = await deps.probe(input.discoveryUrl);
  if (probe === null) return { kind: "fallback", reason: "probe-failed" };
  const registrationEndpoint = probe.registrationEndpoint;
  if (!registrationEndpoint) return { kind: "fallback", reason: "no-registration-endpoint", probe };

  const slug = optimisticDcrClientSlug(probe.issuer ?? registrationEndpoint);
  const scopes = registrationScopes(input.declaredScopes ?? [], probe.scopesSupported ?? []);
  const minted = await deps.register({
    owner: input.owner,
    slug,
    issuer: probe.issuer ?? null,
    registrationEndpoint,
    authorizationUrl: probe.authorizationUrl,
    tokenUrl: probe.tokenUrl,
    resource: probe.resource ?? input.resourceFallback ?? null,
    scopes,
    tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
    clientName: dcrClientNameForIntegration(input.integrationName),
    redirectUri: input.redirectUri,
    originIntegration: input.integration,
  });
  if (minted === null) return { kind: "fallback", reason: "registration-failed", probe };
  // OAuthClientSlug is a branded string; an object return carries the failure
  // message (e.g. the server rejected the redirect URI) for the BYO fallback.
  if (typeof minted === "object") {
    return { kind: "fallback", reason: "registration-failed", probe, message: minted.error };
  }
  deps.start({ client: minted, owner: input.owner });
  return { kind: "started" };
}

// ---------------------------------------------------------------------------
// One row in the OAuth app picker: a radio-select Label plus an actions menu
// (Edit / Remove) so the registered app can be managed inline. The page that
// used to own this management was removed in favour of doing it here, next to
// where the app is picked. The menu lives OUTSIDE the <label> so clicking it
// never toggles the radio.
// ---------------------------------------------------------------------------
function OAuthAppRadioRow(props: {
  readonly app: OAuthClientOption;
  readonly idPrefix: string;
  readonly variant: "matched" | "other";
  readonly showOwnerLabel: boolean;
  readonly onManage?: { readonly onEdit: () => void; readonly onRemove: () => void };
}) {
  const { app, idPrefix, variant, showOwnerLabel, onManage } = props;
  return (
    <div className="flex items-center gap-1">
      <Label
        htmlFor={`${idPrefix}-${app.slug}`}
        className={cn(
          "flex flex-1 cursor-pointer items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5 font-normal has-[:checked]:border-ring has-[:checked]:bg-accent/40",
          variant === "matched" ? "bg-muted/30" : "bg-background/40",
        )}
      >
        <RadioGroupItem id={`${idPrefix}-${app.slug}`} value={String(app.slug)} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{clientDisplayName(String(app.slug))}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {clientHost(app.tokenUrl)} ·{" "}
            {app.grant === "client_credentials" ? "app-to-app" : "you'll sign in"}
          </span>
        </span>
        {showOwnerLabel ? <Badge variant="outline">{ownerLabel(app.owner)}</Badge> : null}
      </Label>
      {onManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label={`Actions for ${String(app.slug)}`}
            >
              <svg viewBox="0 0 16 16" className="size-3.5">
                <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="13" r="1.2" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={onManage.onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-sm"
              onClick={onManage.onRemove}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

interface AddAccountModalProps {
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
}

/** The add-connection modal is self-contained: every transient bit of state
 *  (form fields, the in-flight OAuth popup flow) lives in `AddAccountModalView`,
 *  so closing the modal genuinely unmounts that view and React destroys all of
 *  it, never hand-reset. Unmounting also runs `useOAuthPopupFlow`'s cleanup,
 *  which cancels a dangling server OAuth session. That is why abandoning an
 *  OAuth popup can't wedge a later open: the stuck flow died with its instance.
 *  The parent owns only open/route intent (deep links, the reconnect handoff). */
export function AddAccountModal(props: AddAccountModalProps) {
  return props.open ? <AddAccountModalView {...props} /> : null;
}

// ---------------------------------------------------------------------------
// Key-check verdict: ONE line beside the Validate button carrying everything
// (status dot, label, auto-picked identity, and the "change" escape hatch). It
// shares the button's row (no reserved block, no reveal shift), and the
// in-flight state lives only on the button's spinner.
// ---------------------------------------------------------------------------
/** One verdict line: status dot, label, `· identity` when healthy, `: detail`
 *  when not. Shared by the step-2 recap and the request panel's response
 *  status so the verdict reads identically everywhere. */
function HealthStatusLine(props: {
  readonly result: HealthCheckResult;
  /** Mono + http status for the request panel; sans for the recap line. */
  readonly variant?: "line" | "response";
}) {
  const { status, identity, detail, httpStatus } = props.result;
  const healthy = status === "healthy";
  const tone = healthy ? "text-muted-foreground" : "text-destructive";
  const font = props.variant === "response" ? "font-mono" : "";
  return (
    <div className={`flex min-w-0 items-center gap-2 text-xs ${tone} ${font}`}>
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${HEALTH_INDICATOR_COLOR[status].dot}`}
      />
      {props.variant === "response" && httpStatus !== undefined ? (
        <span className="shrink-0">{httpStatus}</span>
      ) : null}
      <span className="min-w-0 truncate">
        <span className="font-medium">{HEALTH_STATUS_LABEL[status]}</span>
        {healthy && identity ? (
          <>
            {" · "}
            <span className="text-foreground">{identity}</span>
          </>
        ) : null}
        {!healthy && detail ? <span className="opacity-80">: {detail}</span> : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The key check as a request/response panel: the system's code-window
// pattern, because that is literally what this is: one hairline-framed panel
// whose titlebar is the request line (method chip + operation + Check) and
// whose body is the response the key actually got. The operation arrives
// pre-seeded with the best read-only candidate and is editable in place, so
// the user always SEES what will run without filling in a form. The response
// renders read-only, identity fields first; the identity pick happens on
// step 2 as the display name.
// ---------------------------------------------------------------------------
function RequestCheckPanel(props: {
  readonly candidates: readonly HealthCheckCandidate[];
  readonly selected: HealthCheckCandidate | null;
  /** The operation in the request line (pre-seeded or user-picked). */
  readonly operation: string;
  readonly onOperationChange: (operation: string) => void;
  /** Static request line for an already-configured check (no combobox). */
  readonly configuredOperation: string | null;
  readonly args: Record<string, string>;
  readonly onArgChange: (name: string, value: string) => void;
  readonly ready: boolean;
  readonly validating: boolean;
  readonly result: HealthCheckResult | null;
  readonly onCheck: () => void;
}) {
  const { candidates, selected, operation, configuredOperation, result } = props;
  const operationOptions = useMemo<FreeformComboboxOption[]>(
    () =>
      candidates
        .filter((c) => !c.destructive)
        .map((c) => ({
          value: c.operation,
          label: c.operation,
          description: c.summary,
        })),
    [candidates],
  );
  const requiredParams = (selected?.parameters ?? []).filter((p) => p.required);
  const healthy = result?.status === "healthy";
  // Identity-looking fields first, then response order; capped so a chatty
  // response can't blow the modal up (the hidden tail adds nothing, since the
  // interesting fields rank first).
  const { sample, hiddenCount } = useMemo(() => {
    const full = result?.status === "healthy" ? (result.responseSample ?? []) : [];
    const capped = rankResponseSample(full).slice(0, 8);
    return { sample: capped, hiddenCount: full.length - capped.length };
  }, [result]);
  const method = configuredOperation ? "GET" : (selected?.method ?? "get").toUpperCase();

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border">
      {/* Request line: METHOD operation … Check. The operation is a frameless
      combobox so the whole line reads as one request, not a form row. */}
      <div className="flex h-10 min-w-0 items-center bg-muted/40 pr-1.5">
        <span className="shrink-0 select-none pl-3 pr-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {method}
        </span>
        {configuredOperation ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {configuredOperation}
          </span>
        ) : (
          <FreeformCombobox
            id="hc-pick-operation"
            value={operation}
            onValueChange={props.onOperationChange}
            options={operationOptions}
            placeholder="pick a call"
            emptyLabel="No matching operations"
            disabled={props.validating}
            className="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-within:border-0 has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent"
            inputClassName="h-10 px-0 font-mono text-xs"
          />
        )}
        <Button
          type="button"
          variant="secondary"
          size="xs"
          loading={props.validating}
          disabled={!props.ready}
          onClick={props.onCheck}
          className="ml-2 shrink-0"
        >
          Check
        </Button>
      </div>

      {/* Required args, only when the chosen call needs them. */}
      {!configuredOperation && requiredParams.length > 0 ? (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          {requiredParams.map((param) => (
            <div key={param.name} className="flex min-w-0 items-center gap-2.5">
              <Label
                htmlFor={`hc-pick-arg-${param.name}`}
                className="w-32 shrink-0 truncate font-mono text-xs font-normal text-muted-foreground"
              >
                {param.name}
              </Label>
              <Input
                id={`hc-pick-arg-${param.name}`}
                value={props.args[param.name] ?? ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  props.onArgChange(param.name, e.target.value)
                }
                placeholder={param.description ?? "required"}
                disabled={props.validating}
                className="h-7 font-mono text-xs"
              />
            </div>
          ))}
        </div>
      ) : null}

      {/* Response: status line, then a read-only view of what came back. The
      identity pick happens on step 2 (the display name), not here. */}
      {result && !props.validating ? (
        <div className="border-t border-border">
          <div className="px-3 py-2">
            <HealthStatusLine result={result} variant="response" />
          </div>
          {healthy && sample.length > 0 ? (
            // No inner scroller: nested scroll areas trap the wheel mid-modal.
            // The modal is the one scroll context; the row cap bounds height.
            <div className="border-t border-border px-3 py-1.5">
              {sample.map((field) => (
                <div
                  key={field.path}
                  className="flex min-w-0 items-baseline gap-2.5 py-0.5 font-mono text-xs"
                >
                  <span className="w-40 shrink-0 truncate text-muted-foreground">{field.path}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{field.value}</span>
                </div>
              ))}
              {hiddenCount > 0 ? (
                <div className="py-0.5 font-mono text-[11px] text-muted-foreground">
                  +{hiddenCount} more
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
function AddAccountModalView(props: AddAccountModalProps) {
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
  // Key check, probe-first: we auto-pick the top-ranked read-only zero-arg
  // operation and the user just clicks "Check the key works": no form to fill
  // before anything has been seen. The probe's REAL response then doubles as
  // the identity picker (click the field that names the account), so identity
  // is chosen from data, never guessed from a schema. `hcOperation`/`hcArgs`
  // only carry a manual override ("change" escape hatch). All of this lives in
  // the view, so closing the modal unmounts and resets it.
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<HealthCheckResult | null>(null);
  const [hcOperation, setHcOperation] = useState("");
  const [hcArgs, setHcArgs] = useState<Record<string, string>>({});
  // Credential methods run as a TWO-STEP wizard in the same modal: step 1 is
  // the key + proving it works (the request/response panel sits right below
  // the key, which stays visible and editable the whole time); step 2 is
  // naming the connection and picking where it lives. No submodal.
  const [wizardStep, setWizardStep] = useState<"validate" | "place">("validate");
  // The spec a healthy candidate probe saved (the step-2 name pick upgrades it).
  const [savedInlineSpec, setSavedInlineSpec] = useState<HealthCheckSpec | null>(null);
  // Whether the display name was auto-filled from a probed identity (so a later
  // probe may overwrite it, but a hand-typed name is never clobbered).
  const nameAutofilled = useRef(false);
  // Explicit create-time choice (no ambient owner). Cloud defaults to Personal;
  // local/desktop hide the picker and save to the one local workspace.
  const [owner, setOwner] = useState<Owner>(defaultOwner);
  const [submitting, setSubmitting] = useState(false);
  const [pickedApp, setPickedApp] = useState<string | null>(null);
  const [registeringOAuthClient, setRegisteringOAuthClient] = useState(false);
  const [ccBusy, setCcBusy] = useState(false);
  const [cimdBusy, setCimdBusy] = useState(false);
  // Transparent DCR: busy while probing/registering/starting; `dcrFailed` flips
  // the modal to the bring-your-own-app picker if auto setup is unavailable.
  const [dcrBusy, setDcrBusy] = useState(false);
  const [dcrFailed, setDcrFailed] = useState(false);
  const [oauthFallbackProbe, setOAuthFallbackProbe] = useState<DcrProbeResult | null>(null);
  // When transparent DCR is rejected with an actionable reason (e.g. the server
  // refuses our redirect URI), surface it as an inline error card on the
  // bring-your-own-app recovery view instead of a transient toast.
  const [dcrFallbackMessage, setDcrFallbackMessage] = useState<string | null>(null);
  // FIX 3 escape hatch: when no registered app matched the integration's
  // endpoints, the unmatched apps are collapsed behind an opt-in expander.
  const [showOtherApps, setShowOtherApps] = useState(false);
  // Auto-registered (DCR) clients are plumbing, not pickable apps: they live in a
  // collapsed management section at the bottom of the OAuth tab, revealed on
  // demand so they can be inspected and deleted without cluttering the picker.
  const [showAutoRegistered, setShowAutoRegistered] = useState(false);
  // Inline OAuth app management — edit re-opens the registration form for an
  // existing app (upsert by owner+slug); remove confirms before deleting. Both
  // hold the FULL app summary (with endpoints + resource) so the edit prefill
  // and the remove warning have everything they need.
  const [editingClient, setEditingClient] = useState<OAuthClientSummary | null>(null);
  const [removingClient, setRemovingClient] = useState<OAuthClientSummary | null>(null);

  const doCreate = useAtomSet(addConnectionOptimistic(owner), {
    mode: "promiseExit",
  });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doCreateOAuthClient = useAtomSet(createOAuthClientOptimistic, { mode: "promiseExit" });
  const doProbe = useAtomSet(probeOAuth, { mode: "promiseExit" });
  const doRegisterDynamic = useAtomSet(registerDynamicOAuthClient, {
    mode: "promiseExit",
  });
  const doRemoveOAuthClient = useAtomSet(removeOAuthClientOptimistic, { mode: "promise" });
  const doValidate = useAtomSet(validateConnection, { mode: "promiseExit" });
  const doCheckConnectionHealth = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const doUpdateConnection = useAtomSet(updateConnection, { mode: "promiseExit" });
  const doSetHealthCheck = useAtomSet(setIntegrationHealthCheck, { mode: "promiseExit" });

  // The integration's declared health check + its candidate operations. When a
  // check is configured we probe against it; when not, the user picks one of the
  // candidates inline to test the key (and we save it).
  const healthCheckResult = useAtomValue(integrationHealthCheckAtom(integration));
  const configuredHealthCheck = AsyncResult.isSuccess(healthCheckResult)
    ? healthCheckResult.value
    : null;
  const hasHealthCheck = configuredHealthCheck !== null;
  const candidatesResult = useAtomValue(integrationHealthCheckCandidatesAtom(integration));
  const healthCheckCandidates = useMemo(
    () => (AsyncResult.isSuccess(candidatesResult) ? candidatesResult.value : []),
    [candidatesResult],
  );

  // Full registered-app summaries (carry endpoints + resource the picker's
  // lightweight options omit) and the connection→app usage map that powers the
  // remove warning. Both are secondary reads — a not-yet-loaded list just means
  // no management affordance / no usage badge until it arrives.
  const allClientsResult = useAtomValue(oauthClientsOptimisticAtom);
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const clientSummaries = useMemo<readonly OAuthClientSummary[]>(
    () => (AsyncResult.isSuccess(allClientsResult) ? allClientsResult.value : []),
    [allClientsResult],
  );
  const usage = useMemo(
    () => buildUsageMap(AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : []),
    [connectionsResult],
  );

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
    setOAuthFallbackProbe(null);
    setDcrFailed(false);
    setDcrFallbackMessage(null);
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

  // Non-secret prefill carried by an `oauth.clients.createHandoff` deep link.
  // The agent fills in the endpoints/grant/client id it discovered; the client
  // secret is deliberately absent and is typed by the human in the form below.
  const oauthClientHandoff = initialState?.oauthClient;
  const oauthHandoffPrefill = useMemo<OAuthClientFormPrefill | undefined>(() => {
    if (!oauthClientHandoff) return undefined;
    const grant =
      oauthClientHandoff.grant === "authorization_code" ||
      oauthClientHandoff.grant === "client_credentials"
        ? oauthClientHandoff.grant
        : undefined;
    return {
      ...(oauthClientHandoff.authorizationUrl
        ? { authorizationUrl: oauthClientHandoff.authorizationUrl }
        : {}),
      ...(oauthClientHandoff.tokenUrl ? { tokenUrl: oauthClientHandoff.tokenUrl } : {}),
      ...(oauthClientHandoff.resource ? { resource: oauthClientHandoff.resource } : {}),
      ...(grant ? { grant } : {}),
      ...(oauthClientHandoff.clientId ? { clientId: oauthClientHandoff.clientId } : {}),
    };
  }, [oauthClientHandoff]);

  // Jump straight into the Register-OAuth-app sub-view when the agent handed off
  // an OAuth-app registration. Fire once per handoff key (tracked by ref) so the
  // user can cancel back out without it springing open again; retries on later
  // renders only while the methods list is still empty.
  const oauthHandoffOpenedKey = useRef<string | null>(null);
  const oauthReconnectOpenedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!initialState?.oauthClient) return;
    if (initialState.oauthClient.action === "reconnect") return;
    if (oauthHandoffOpenedKey.current === initialState.key) return;
    const oauthMethod = allMethods.find((m: AuthMethod) => m.kind === "oauth");
    if (!oauthMethod) return;
    oauthHandoffOpenedKey.current = initialState.key;
    setMethodId(oauthMethod.id);
    setRegisteringOAuthClient(true);
  }, [initialState, allMethods]);

  const isOAuth = method?.kind === "oauth";
  const isNoAuth = method?.kind === "none";

  // Key check (pasteable credentials only): offer it whenever the integration
  // either has a configured check OR exposes candidate operations to test
  // against. The request line arrives pre-seeded with the best read-only
  // zero-argument candidate so the user SEES what will run and edits in place.
  // Candidates arrive pre-sorted best-first (identity-aware, server-side);
  // the seed is simply the best one that can run without arguments, falling
  // back to the best non-destructive one.
  const hcBestCandidate = useMemo(
    () =>
      healthCheckCandidates.find(
        (candidate) => !candidate.destructive && candidate.requiredArgCount === 0,
      ) ??
      healthCheckCandidates.find((candidate) => !candidate.destructive) ??
      null,
    [healthCheckCandidates],
  );
  useEffect(() => {
    if (hcBestCandidate && hcOperation.length === 0) {
      setHcOperation(hcBestCandidate.operation);
    }
    // Seed once per candidate load; a user clearing the field mid-session is
    // re-seeded only when candidates change, which is the useful behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hcBestCandidate]);
  const hcSelected = healthCheckCandidates.find((c) => c.operation === hcOperation) ?? null;
  // Step 2's display name offers the response's identity-looking fields as
  // options (email > login > name > id); picking one also stores it as the
  // check's identityField so future probes label the connection live.
  const nameOptions = useMemo<FreeformComboboxOption[]>(() => {
    const sample =
      validationResult?.status === "healthy" ? (validationResult.responseSample ?? []) : [];
    return rankResponseSample(sample)
      .filter((field) => identityPathTier(field.path) !== -1)
      .map((field) => ({
        value: field.value,
        label: field.value,
        description: field.path,
      }));
  }, [validationResult]);
  const hcRequiredParams = (hcSelected?.parameters ?? []).filter((p) => p.required);
  const hcMissingRequired = hcRequiredParams.some(
    (p) => (hcArgs[p.name] ?? "").trim().length === 0,
  );
  const canCheckKey = !isOAuth && !isNoAuth && (hasHealthCheck || healthCheckCandidates.length > 0);
  // Pick mode's probe is runnable once an operation is chosen and its required
  // args are filled.
  const hcCandidateReady = hcOperation.length > 0 && !hcMissingRequired;

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
  // A stdio env method: every credential is injected as an environment variable
  // (carrier "env"). These read as named secrets, not an HTTP placement, so we
  // skip the `KEY=••••••` placement preview and label each field by its var.
  const isEnvMethod =
    method != null &&
    method.placements.length > 0 &&
    method.placements.every((p) => p.carrier === "env");
  // CIMD-capable: the provider accepts a client_id that is a metadata-document
  // URL, so we can create a public local client and skip provider app
  // registration entirely.
  const isCimd = isOAuth && method?.oauth?.supportsClientIdMetadataDocument === true;
  const cimdActive = isCimd;
  // Single-input header/query methods: the placement's lead + prefix (e.g.
  // "Authorization: Bearer ") merges INTO the credential field as a non-editable
  // affix, so the input reads as the header value being built and the separate
  // preview line is dropped. Env and multi-input methods keep the plain field.
  const singleCredentialAffix = useMemo<string | null>(() => {
    if (!method || !singleInput || isEnvMethod) return null;
    const placement = method.placements.find((p) => p.carrier !== "env");
    if (!placement) return null;
    const lead =
      placement.carrier === "header"
        ? `${placement.name || "Authorization"}: `
        : `?${placement.name || "api_key"}=`;
    return `${lead}${placement.prefix ?? ""}`;
  }, [method, singleInput, isEnvMethod]);
  // DCR-capable: the integration advertises dynamic registration (MCP oauth2),
  // OR carries a discovery URL we can probe at connect time. When DCR-capable
  // and not yet fallen back, we skip the app picker entirely (Option A).
  const isDcr =
    !cimdActive &&
    isOAuth &&
    (method?.oauth?.supportsDynamicRegistration === true || method?.oauth?.discoveryUrl != null);
  const dcrActive = isDcr && !dcrFailed;
  const automaticOAuthActive = cimdActive || dcrActive;

  // OAuth apps usable for this integration (user-owned first). Hooks run
  // unconditionally; in DCR mode the result is ignored until/unless we fall back.
  const {
    clients: oauthApps,
    nearMatches: oauthNearApps,
    otherClients: oauthOtherApps,
    loading: oauthLoading,
    endpointMatched: oauthEndpointMatched,
    displayRegisterCTA: oauthDisplayRegisterCTA,
  } = useOAuthClientsForIntegration({
    // MCP integrations declare no endpoints up front; once DCR has probed the
    // server we match registered apps against the DISCOVERED endpoints. With no
    // endpoints to match (a server-targeting MCP integration), require an
    // explicit match so we surface the register CTA instead of auto-selecting an
    // unrelated provider's app.
    tokenUrl: method?.oauth?.tokenUrl ?? oauthFallbackProbe?.tokenUrl,
    authorizationUrl: method?.oauth?.authorizationUrl ?? oauthFallbackProbe?.authorizationUrl,
    // Recorded intent: a manual app registered from THIS integration's dialog is
    // a tier-1 match regardless of host.
    integration,
    requireEndpointMatch: isDcr,
  });
  // Auto-registered (DCR) clients for THIS integration. Excluded from the picker
  // above, but surfaced in a collapsed management section so they stay
  // deletable. Reads the same optimistic list the picker does.
  const dcrClients = useMemo(
    () =>
      selectDcrClientsForIntegration(clientSummaries as readonly OAuthClientOption[], {
        integration,
        tokenUrl: method?.oauth?.tokenUrl ?? oauthFallbackProbe?.tokenUrl,
        authorizationUrl: method?.oauth?.authorizationUrl ?? oauthFallbackProbe?.authorizationUrl,
      }),
    [
      clientSummaries,
      integration,
      method?.oauth?.tokenUrl,
      method?.oauth?.authorizationUrl,
      oauthFallbackProbe,
    ],
  );
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
  // Editing reuses the registration form (createClient upserts by owner+slug),
  // so it occupies the same full-bleed sub-view as registering.
  const oauthEditing = isOAuth && editingClient !== null;
  // Resolve the picked slug across every PICKABLE tier: exact matches, the
  // subdued near-match tier, and the unrelated escape-hatch apps. All three are
  // selectable (only the default auto-selection is restricted to tier 1), so the
  // connect button must resolve a client from any of them. DCR clients are not
  // in these lists, so they can never be chosen as the connect app.
  const chosenClient: OAuthClientOption | null =
    [...oauthApps, ...oauthNearApps, ...oauthOtherApps].find(
      (c: OAuthClientOption) => String(c.slug) === selectedApp,
    ) ?? null;
  const oauthBusy = ccBusy || oauthPopup.busy;
  const cimdConnecting = cimdBusy || oauthPopup.busy;
  const dcrConnecting = dcrBusy || oauthPopup.busy;
  const automaticOAuthConnecting = cimdConnecting || dcrConnecting;

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
  const savedToOptions = isOAuth && !automaticOAuthActive ? oauthConnectionOptions : ownerOptions;
  const savedToOwner = isOAuth && !automaticOAuthActive ? oauthConnectionOwner : owner;
  const showSavedToPicker = !oauthRegistering && savedToOptions.length > 1;
  const callableName = connectionNameFrom(label, savedToOwner, integrationName, organizationId);
  const authStepLabel = isOAuth ? (cimdActive ? "OAuth setup" : "OAuth app") : "Credential";

  // Build the picker row's Edit/Remove menu for an app, but only once its full
  // summary has loaded (the picker option lacks endpoints/resource). Until then
  // the row shows no actions menu rather than a broken one.
  const manageHandlersFor = (
    appOption: OAuthClientOption,
  ): { readonly onEdit: () => void; readonly onRemove: () => void } | undefined => {
    const summary = clientSummaries.find(
      (c: OAuthClientSummary) =>
        c.owner === appOption.owner && String(c.slug) === String(appOption.slug),
    );
    if (!summary) return undefined;
    return {
      onEdit: () => setEditingClient(summary),
      onRemove: () => setRemovingClient(summary),
    };
  };

  // Remove a registered app. Removal never cascades into its connections (they
  // reconnect at their next refresh); clear the picked app if it was the one
  // removed so the connect button doesn't point at a gone slug.
  const handleRemoveApp = async (client: OAuthClientSummary): Promise<void> => {
    setRemovingClient(null);
    await doRemoveOAuthClient({
      params: { slug: client.slug },
      payload: { owner: client.owner },
      reactivityKeys: oauthClientWriteKeys,
    });
    trackEvent("oauth_client_removed", { owner: client.owner });
    toast.success(`Removed ${String(client.slug)}`);
    if (pickedApp === String(client.slug)) setPickedApp(null);
  };

  const selectMethod = (nextMethodId: string): void => {
    setMethodId(nextMethodId);
    setValues({});
    setCredentialOrigin("paste");
    setOnePasswordItemId("");
    setDcrFailed(false);
    setOAuthFallbackProbe(null);
    setDcrFallbackMessage(null);
    setWizardStep("validate");
  };

  // A just-created custom method joins the in-session list and is auto-selected
  // so the user can immediately add an account with it. The catalog refresh
  // (via the plugin's `integrationWriteKeys`) reconciles it shortly after.
  const handleCustomMethodCreated = (created: AuthMethod): void => {
    trackEvent("custom_auth_method_created", {
      integration_slug: String(integration),
      kind: created.kind,
    });
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
    trackEvent("custom_auth_method_removed", { integration_slug: String(integration) });
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

  // Just ask the parent to close. Reopening remounts this whole component (see
  // AddAccountModal), so there is nothing to hand-reset: the form fields and the
  // OAuth popup flow's busy state die with this instance.
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    const handoff = initialState;
    const oauthClient = handoff?.oauthClient;
    if (!handoff || oauthClient?.action !== "reconnect") return;
    if (oauthReconnectOpenedKey.current === handoff.key) return;
    const client = oauthClient.slug;
    const clientOwner = oauthClient.owner ?? handoff.owner;
    const connectionOwner = handoff.owner;
    const connectionName = handoff.label;
    const oauthMethod = handoff.template
      ? allMethods.find(
          (m: AuthMethod) =>
            m.kind === "oauth" &&
            (m.id === handoff.template || String(m.template) === handoff.template),
        )
      : allMethods.find((m: AuthMethod) => m.kind === "oauth");
    if (!client || !clientOwner || !connectionOwner || !connectionName || !oauthMethod) return;

    oauthReconnectOpenedKey.current = handoff.key;
    setMethodId(oauthMethod.id);
    void oauthPopup.start({
      payload: {
        client: OAuthClientSlug.make(client),
        clientOwner,
        owner: connectionOwner,
        name: ConnectionName.make(connectionName),
        integration,
        template: oauthMethod.template,
        ...(handoff.identityLabel !== undefined ? { identityLabel: handoff.identityLabel } : {}),
      },
      onAuthorizationStarted: () => {
        trackEvent("connection_reconnected", {
          integration_slug: String(integration),
          owner: connectionOwner,
          success: true,
        });
      },
      onError: () => {
        trackEvent("connection_reconnected", {
          integration_slug: String(integration),
          owner: connectionOwner,
          success: false,
        });
      },
      onSuccess: () => {
        toast.success("Reconnected");
        close();
      },
    });
  }, [initialState, allMethods, integration, oauthPopup, close]);

  const probeAndAutoNameOAuthConnection = async (
    connection: OAuthCompletionPayload,
    typedLabel: string,
    defaultIdentityLabel: string,
  ): Promise<void> => {
    const check = await doCheckConnectionHealth({
      params: {
        owner: connection.owner,
        integration: connection.integration,
        name: connection.name,
      },
      query: {},
      reactivityKeys: connectionCheckKeys,
    });
    if (Exit.isFailure(check)) return;
    const nextIdentityLabel = oauthIdentityLabelFromHealth({
      result: check.value,
      typedLabel,
      storedIdentityLabel: connection.identityLabel,
      defaultIdentityLabel,
    });
    if (nextIdentityLabel === null) return;
    const updated = await doUpdateConnection({
      params: {
        owner: connection.owner,
        integration: connection.integration,
        name: connection.name,
      },
      payload: { identityLabel: nextIdentityLabel },
      reactivityKeys: connectionWriteKeys,
    });
    if (Exit.isFailure(updated)) {
      toast.error(messageFromExit(updated, "Couldn't update connection name"));
    }
  };

  const credentialPayloadOrigin = createCredentialPayloadOrigin({
    origin: credentialOrigin,
    inputs: credentialInputs,
    values,
    onePasswordItemId,
    singleInput,
  });

  const canSubmit = method != null && !submitting && credentialPayloadOrigin !== null;
  // The two-step wizard applies to credential methods only (OAuth connects in
  // one act; its flow is unchanged).
  const wizardActive = !isOAuth && !isNoAuth;
  // Continue is NEVER disabled (a disabled button hides the reason and drops
  // out of tab order). Clicking it with no key says exactly what's missing.
  const [continueError, setContinueError] = useState<string | null>(null);
  // Which wizard sections show. OAuth/no-auth methods aren't a wizard, so
  // they show everything at once.
  const showValidateStep = !wizardActive || wizardStep === "validate";
  const showPlaceStep = !wizardActive || wizardStep === "place";

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
    trackEvent("connection_credential_submitted", {
      integration_slug: String(integration),
      owner,
      credential_origin: credentialOrigin,
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      setSubmitting(false);
      toast.error(messageFromExit(exit, "Failed to add connection"));
      return;
    }
    toast.success("Connection added");
    close();
  };

  // A pasted credential (or the picked operation) changed; the prior verdict is
  // stale. Clear it so the status line doesn't show a result for a key/operation
  // that is no longer what's in the form.
  const clearKeyCheck = (): void => {
    if (validationResult !== null) setValidationResult(null);
    if (savedInlineSpec !== null) setSavedInlineSpec(null);
    if (continueError !== null) setContinueError(null);
  };

  // Check the key works: probe the pasted credential WITHOUT saving the
  // connection. When the integration has a configured health check we run it;
  // otherwise we run the inline-picked candidate and, if it comes back healthy,
  // save it as the integration's health check (so it's configured "then").
  // Probe the pasted credential WITHOUT saving the connection. With a
  // configured check the panel's Check runs this directly; with none it runs
  // via handleCandidateProbe, which drafts a spec from the picked candidate.
  const handleValidate = async (draftSpec?: HealthCheckSpec) => {
    const payloadOrigin = createCredentialPayloadOrigin({
      origin: credentialOrigin,
      inputs: credentialInputs,
      values,
      onePasswordItemId,
      singleInput,
    });
    if (!method || payloadOrigin === null || validating) return;
    setValidating(true);
    const exit = await doValidate({
      payload: {
        owner,
        integration,
        template: method.template,
        ...(draftSpec ? { spec: draftSpec } : {}),
        ...("from" in payloadOrigin
          ? { from: payloadOrigin.from }
          : { values: payloadOrigin.values }),
      },
    });
    setValidating(false);
    if (Exit.isFailure(exit)) {
      setValidationResult(null);
      toast.error(messageFromExit(exit, "Couldn't check the key"));
      return;
    }
    const result = exit.value;
    setValidationResult(result);
    // A drafted candidate spec that probes healthy becomes the integration's
    // health check, so the editor + status surfaces pick it up; the step-2
    // name pick can upgrade it with an identity field after.
    if (draftSpec && result.status === "healthy") {
      const saved = await doSetHealthCheck({
        params: { slug: integration },
        payload: { spec: draftSpec },
        reactivityKeys: healthCheckWriteKeys,
      });
      if (Exit.isSuccess(saved)) {
        setSavedInlineSpec(draftSpec);
      } else {
        // The key is healthy but the spec did NOT persist: say so, or the
        // user walks away believing the check is configured.
        toast.error(messageFromExit(saved, "The key works, but saving the health check failed"));
      }
    }
    // Derive the connection name from the probed identity, unless the user
    // hand-typed one (only fill when empty or a prior auto-fill). Read the
    // CURRENT label via the functional updater, not the closure's snapshot:
    // the user may have typed a name while the probe was in flight, and a
    // hand-typed name is never clobbered.
    const probedIdentity = result.identity?.trim();
    if (result.status === "healthy" && probedIdentity && probedIdentity.length > 0) {
      setLabel((current) => {
        if (current.trim().length > 0 && !nameAutofilled.current) return current;
        nameAutofilled.current = true;
        return probedIdentity;
      });
    }
  };

  // No configured check: build a draft spec from the picked candidate and
  // probe with it.
  const handleCandidateProbe = async () => {
    if (!hcCandidateReady) return;
    const argEntries = Object.entries(hcArgs)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0);
    await handleValidate({
      operation: hcOperation,
      ...(argEntries.length > 0 ? { args: Object.fromEntries(argEntries) } : {}),
    });
  };

  // The user clicked a field in the probe's response: that field IS the
  // identity. Upgrade the just-saved spec with it, and (unless hand-typed)
  // adopt its value as the display name: it's the account label, live.
  const handlePickIdentity = async (path: string, value: string) => {
    if (savedInlineSpec) {
      const upgraded: HealthCheckSpec = { ...savedInlineSpec, identityField: path };
      const saved = await doSetHealthCheck({
        params: { slug: integration },
        payload: { spec: upgraded },
        reactivityKeys: healthCheckWriteKeys,
      });
      if (Exit.isSuccess(saved)) {
        setSavedInlineSpec(upgraded);
      } else {
        toast.error(messageFromExit(saved, "Couldn't save the identity field"));
        return;
      }
    }
    setValidationResult((current) => (current ? { ...current, identity: value } : current));
    setLabel((current) => {
      if (current.trim().length > 0 && !nameAutofilled.current) return current;
      nameAutofilled.current = true;
      return value;
    });
  };

  const handleOAuthConnect = async () => {
    if (!method || !chosenClient) return;
    // The connection is minted under the user-picked "saved to" owner, NOT the
    // app's owner: a Workspace (shared) app can mint a Personal connection. The
    // backend resolves the app own→shared from the slug, so the payload carries
    // only the host-resolved connection owner.
    const connectionOwner = oauthConnectionOwner;
    const identityLabel = connectionLabelForHost(
      label,
      connectionOwner,
      integrationName,
      organizationId,
    );
    const payload = {
      client: chosenClient.slug,
      clientOwner: chosenClient.owner,
      owner: connectionOwner,
      name: connectionNameFrom(label, connectionOwner, integrationName, organizationId),
      integration,
      template: method.template,
      identityLabel,
    };
    // client_credentials mints inline (no redirect); authorization_code runs the popup.
    if (chosenClient.grant === "client_credentials") {
      setCcBusy(true);
      const exit = await doStartOAuth({
        payload,
        reactivityKeys: connectionWriteKeys,
      });
      trackEvent("connection_oauth_started", {
        integration_slug: String(integration),
        owner: connectionOwner,
        flow: "byo",
        success: Exit.isSuccess(exit),
      });
      if (Exit.isFailure(exit)) {
        setCcBusy(false);
        toast.error(messageFromExit(exit, "Failed to connect"));
        return;
      }
      if (exit.value.status === "connected") {
        await probeAndAutoNameOAuthConnection(exit.value.connection, label, identityLabel);
      }
      setCcBusy(false);
      toast.success("Connection added");
      close();
      return;
    }
    // Fire once per attempt: success when the authorization actually started
    // (URL minted, popup open), failure only for start-phase errors — later
    // completion errors belong to oauth_completed, not this event.
    let startReported = false;
    void oauthPopup.start({
      payload,
      onAuthorizationStarted: () => {
        startReported = true;
        trackEvent("connection_oauth_started", {
          integration_slug: String(integration),
          owner: connectionOwner,
          flow: "byo",
          success: true,
        });
      },
      onError: () => {
        if (startReported) return;
        startReported = true;
        trackEvent("connection_oauth_started", {
          integration_slug: String(integration),
          owner: connectionOwner,
          flow: "byo",
          success: false,
        });
      },
      onSuccess: async (connection: OAuthCompletionPayload) => {
        await probeAndAutoNameOAuthConnection(connection, label, identityLabel);
        toast.success("Connection added");
        close();
      },
    });
  };

  const handleCimdConnect = async () => {
    const authorizationUrl = method?.oauth?.authorizationUrl;
    const tokenUrl = method?.oauth?.tokenUrl;
    if (!method || !authorizationUrl || !tokenUrl) {
      toast.error("OAuth metadata is missing endpoints");
      return;
    }
    const cimdOwner = owner;
    const connectionName = connectionNameFrom(label, cimdOwner, integrationName, organizationId);
    const identityLabel = connectionLabelForHost(label, cimdOwner, integrationName, organizationId);
    setCimdBusy(true);
    const outcome = await runCimdConnect(
      {
        createClient: async (args: CimdCreateClientArgs): Promise<OAuthClientSlug | null> => {
          const exit = await doCreateOAuthClient({
            payload: {
              owner: args.owner,
              slug: args.slug,
              authorizationUrl: args.authorizationUrl,
              tokenUrl: args.tokenUrl,
              resource: args.resource ?? null,
              grant: args.grant,
              clientId: args.clientId,
              clientSecret: args.clientSecret,
            },
            reactivityKeys: oauthClientWriteKeys,
          });
          if (Exit.isFailure(exit)) return null;
          return exit.value.client;
        },
        start: (args: { readonly client: OAuthClientSlug; readonly owner: Owner }): void => {
          void oauthPopup.start({
            payload: {
              client: args.client,
              // CIMD creates the public client under the connection owner, so
              // the app and connection share one owner.
              clientOwner: args.owner,
              owner: args.owner,
              name: connectionName,
              integration,
              template: method.template,
              identityLabel,
            },
            onSuccess: async (connection: OAuthCompletionPayload) => {
              await probeAndAutoNameOAuthConnection(connection, label, identityLabel);
              toast.success("Connection added");
              close();
            },
          });
        },
      },
      {
        owner: cimdOwner,
        integrationName,
        authorizationUrl,
        tokenUrl,
        resource: method.oauth?.resource ?? null,
        clientIdMetadataDocumentUrl: oauthClientIdMetadataDocumentUrl(),
        existingClients: clientSummaries,
      },
    );
    setCimdBusy(false);
    trackEvent("connection_oauth_started", {
      integration_slug: String(integration),
      owner: cimdOwner,
      flow: "cimd",
      success: outcome.kind === "started",
    });
    if (outcome.kind === "failed") {
      toast.error("Client metadata setup failed");
    }
  };

  // Transparent DCR connect: probe → register → start, no app picker. On any
  // failure (probe error, no registration endpoint, or registration failure) we
  // flip `dcrFailed` so the bring-your-own-app picker renders as the recovery
  // path with name/owner kept.
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
        register: async (
          args: DcrRegisterArgs,
        ): Promise<OAuthClientSlug | { readonly error: string } | null> => {
          const exit = await doRegisterDynamic({
            payload: {
              owner: args.owner,
              slug: args.slug,
              issuer: args.issuer ?? null,
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
          if (Exit.isFailure(exit)) {
            return {
              error: messageFromExit(exit, "Automatic setup unavailable. Register an app instead."),
            };
          }
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
            onSuccess: async (connection: OAuthCompletionPayload) => {
              await probeAndAutoNameOAuthConnection(connection, label, identityLabel);
              toast.success("Connection added");
              close();
            },
          });
        },
      },
      {
        discoveryUrl,
        // Only a genuine discovery URL (MCP) seeds the RFC 8707 resource
        // indicator; the token-endpoint fallback baked into `discoveryUrl` must
        // not, so pass the un-collapsed method value here.
        resourceFallback: method.oauth?.discoveryUrl,
        owner: dcrOwner,
        integrationName,
        // DCR slugs are server-keyed (Part A): the connect path no longer depends
        // on the picker's app list, so it need not be threaded here.
        declaredScopes: method.oauth?.scopes,
        redirectUri: oauthCallbackUrl(),
        integration,
      },
    );
    setDcrBusy(false);
    trackEvent("connection_oauth_started", {
      integration_slug: String(integration),
      owner: dcrOwner,
      flow: "dcr",
      success: outcome.kind === "started",
      ...(outcome.kind === "fallback" ? { dcr_fallback: true } : {}),
    });
    if (outcome.kind === "fallback") {
      setOAuthFallbackProbe("probe" in outcome ? outcome.probe : null);
      setDcrFailed(true);
      // Surface the server's actionable rejection reason on the recovery view as
      // an inline error card. Generic fallbacks (no message) fall through to the
      // "register an app" empty state, which already guides the user.
      setDcrFallbackMessage("message" in outcome ? (outcome.message ?? null) : null);
    }
  };

  return (
    // Non-modal for the same reason as the health-check editor sheet: a modal
    // dialog's react-remove-scroll locks the wheel to the dialog subtree, so
    // the operation combobox's PORTALED popup (and the modal body while it is
    // open) cannot scroll. The overlay still dims and outside-click still
    // closes; the portaled-popup guard in DialogContent keeps option clicks
    // from dismissing.
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        forceOverlay
        onInteractOutside={
          oauthClientHandoff?.action === "reconnect" ? (event) => event.preventDefault() : undefined
        }
        className={cn(
          "max-h-[85vh] overflow-x-hidden overflow-y-auto",
          (addingMethod && createCustomMethod) || oauthRegistering || oauthEditing
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
        ) : oauthEditing && editingClient ? (
          <>
            <DialogHeader className="border-b border-border/60 px-5 py-4">
              <DialogTitle className="text-base">Edit {String(editingClient.slug)}</DialogTitle>
              <DialogDescription className="text-sm">
                Update this {ownerLabel(editingClient.owner).toLowerCase()} app&apos;s client
                credentials or endpoints. Re-enter the client secret to save.
              </DialogDescription>
            </DialogHeader>
            <div className="px-5 py-5">
              <OAuthClientForm
                integrationName={integrationName}
                existingSlugs={clientSummaries.map((c: OAuthClientSummary) => String(c.slug))}
                fixedSlug={editingClient.slug}
                fixedOwner={editingClient.owner}
                // Preserve the app's already-recorded origin verbatim (only a
                // "manual" origin carries a recorded integration; DCR apps
                // aren't edited through this form). Editing must never
                // re-derive this from the current dialog's integration.
                intentIntegration={
                  editingClient.origin.kind === "manual"
                    ? (editingClient.origin.integration ?? null)
                    : null
                }
                prefill={{
                  authorizationUrl: editingClient.authorizationUrl,
                  tokenUrl: editingClient.tokenUrl,
                  resource: editingClient.resource ?? null,
                  grant: editingClient.grant,
                  clientId: editingClient.clientId,
                }}
                onCreated={() => setEditingClient(null)}
                onCancel={() => setEditingClient(null)}
                surface="plain"
              />
            </div>
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
                integrationSlug={integration}
                existingSlugs={clientSummaries.map((c: OAuthClientSummary) => String(c.slug))}
                autoRegisterRejectedReason={dcrFallbackMessage}
                prefill={{
                  authorizationUrl:
                    oauthHandoffPrefill?.authorizationUrl ??
                    method.oauth?.authorizationUrl ??
                    oauthFallbackProbe?.authorizationUrl,
                  tokenUrl:
                    oauthHandoffPrefill?.tokenUrl ??
                    method.oauth?.tokenUrl ??
                    oauthFallbackProbe?.tokenUrl,
                  resource:
                    oauthHandoffPrefill?.resource ??
                    oauthFallbackProbe?.resource ??
                    method.oauth?.discoveryUrl ??
                    null,
                  scopes: method.oauth?.scopes,
                  discoveredScopes: oauthFallbackProbe?.scopesSupported,
                  issuer: oauthFallbackProbe?.issuer ?? null,
                  registrationEndpoint:
                    method.oauth?.registrationEndpoint ??
                    oauthFallbackProbe?.registrationEndpoint ??
                    undefined,
                  tokenEndpointAuthMethodsSupported:
                    oauthFallbackProbe?.tokenEndpointAuthMethodsSupported,
                  ...(oauthHandoffPrefill?.grant ? { grant: oauthHandoffPrefill.grant } : {}),
                  ...(oauthHandoffPrefill?.clientId
                    ? { clientId: oauthHandoffPrefill.clientId }
                    : {}),
                  ...(oauthHandoffPrefill?.resource != null
                    ? { resource: oauthHandoffPrefill.resource }
                    : method.oauth?.resource != null
                      ? { resource: method.oauth.resource }
                      : {}),
                }}
                fixedSlug={
                  oauthClientHandoff?.slug != null && oauthClientHandoff.slug.length > 0
                    ? OAuthClientSlug.make(oauthClientHandoff.slug)
                    : undefined
                }
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
              <DialogTitle>
                Add connection · {integrationName}
                {wizardActive ? (
                  <span className="ml-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Step {wizardStep === "validate" ? 1 : 2} of 2
                  </span>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                {ownerDisplay.showOwnerLabels
                  ? "A connection is a saved way to use this integration, owned by you or the workspace."
                  : "A connection is a saved way to use this integration."}
              </DialogDescription>
            </DialogHeader>

            <div className="flex w-full min-w-0 flex-col gap-5">
              {(!dcrActive || createCustomMethod) && showValidateStep && (
                <Tabs
                  value={methodId}
                  onValueChange={selectMethod}
                  className="w-full min-w-0 max-w-full gap-0"
                >
                  <TabsList className="flex h-10 w-full min-w-0 max-w-full justify-start overflow-x-auto overflow-y-hidden rounded-b-none rounded-t-md border border-b-0 border-border/60 bg-muted/30 p-1 [scrollbar-width:thin]">
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
                      className={cn(
                        "mt-0 min-w-0 space-y-5",
                        // No-auth renders no fields, so skip the framed box that
                        // would otherwise show up as an empty bordered panel.
                        // Otherwise the panel attaches to the tab header above
                        // (square top, rounded bottom).
                        isNoAuth
                          ? null
                          : "rounded-b-md rounded-t-none border border-border/60 bg-muted/15 p-4",
                      )}
                    >
                      {method?.placements && !isEnvMethod && singleInput && !singleCredentialAffix
                        ? (() => {
                            const shown = method.placements.filter((p) => p.carrier !== "env");
                            return shown.length > 0 ? (
                              <div className="flex flex-wrap gap-x-3.5 gap-y-1">
                                {shown.map((placement, i: number) => (
                                  <PlacementLine key={i} placement={placement} />
                                ))}
                              </div>
                            ) : null;
                          })()
                        : null}

                      {!isNoAuth && (
                        <div className="space-y-2">
                          <StepHeader index={1} label={authStepLabel} />

                          {isOAuth && method ? (
                            cimdActive ? (
                              <div className="space-y-2 rounded-lg border border-ring/40 bg-accent/30 px-3 py-3">
                                <p className="text-sm font-medium">No app registration</p>
                                <p className="text-xs text-muted-foreground">
                                  {cimdConnecting
                                    ? `Connecting to ${integrationName}…`
                                    : `${integrationName} supports Client ID Metadata Document OAuth. We'll use this Executor host's public client metadata document and sign you in.`}
                                </p>
                              </div>
                            ) : dcrActive ? (
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
                                {dcrFallbackMessage ? (
                                  <div
                                    role="alert"
                                    className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-3"
                                  >
                                    <p className="text-sm font-medium text-destructive">
                                      Couldn&apos;t set up {integrationName} automatically
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {dcrFallbackMessage}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      Register an app below to connect.
                                    </p>
                                  </div>
                                ) : null}
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
                                        {dcrFallbackMessage
                                          ? "Manually register an app"
                                          : "Register app"}
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
                                          <OAuthAppRadioRow
                                            key={String(app.slug)}
                                            app={app}
                                            idPrefix="other-app"
                                            variant="other"
                                            showOwnerLabel={ownerDisplay.showOwnerLabels}
                                            onManage={manageHandlersFor(app)}
                                          />
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
                                      <OAuthAppRadioRow
                                        key={String(app.slug)}
                                        app={app}
                                        idPrefix="app"
                                        variant="matched"
                                        showOwnerLabel={ownerDisplay.showOwnerLabels}
                                        onManage={manageHandlersFor(app)}
                                      />
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

                                {/* Tier 2 — apps that only match by root domain (a
                        near-miss, e.g. the same provider's MCP app for a REST
                        integration). Visually separated and subdued so they are
                        never mistaken for the integration's own app, but still
                        selectable as an escape hatch. Shown alongside tier 1, not
                        mixed into it. */}
                                {oauthNearApps.length > 0 && (
                                  <div className="space-y-2 border-t border-border/60 pt-3">
                                    <p className="text-xs font-medium text-muted-foreground">
                                      Other apps on this provider
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      These share {integrationName}&apos;s domain but weren&apos;t
                                      registered for it. Pick one only if you know it applies.
                                    </p>
                                    <RadioGroup
                                      value={selectedApp}
                                      onValueChange={setPickedApp}
                                      className="gap-2 pt-1"
                                    >
                                      {oauthNearApps.map((app: OAuthClientOption) => (
                                        <OAuthAppRadioRow
                                          key={String(app.slug)}
                                          app={app}
                                          idPrefix="near-app"
                                          variant="other"
                                          showOwnerLabel={ownerDisplay.showOwnerLabels}
                                          onManage={manageHandlersFor(app)}
                                        />
                                      ))}
                                    </RadioGroup>
                                  </div>
                                )}

                                {/* Auto-registered (DCR) clients: plumbing, never
                        pickable. Kept here, collapsed, so they can be reviewed
                        and deleted without cluttering the picker. */}
                                {dcrClients.length > 0 && (
                                  <div className="border-t border-border/60 pt-3">
                                    <Collapsible
                                      open={showAutoRegistered}
                                      onOpenChange={setShowAutoRegistered}
                                    >
                                      <CollapsibleTrigger className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                                        <span>Auto-registered clients ({dcrClients.length})</span>
                                        <ChevronDown
                                          className={cn(
                                            "size-3.5 transition-transform",
                                            showAutoRegistered && "rotate-180",
                                          )}
                                          aria-hidden="true"
                                        />
                                      </CollapsibleTrigger>
                                      <CollapsibleContent>
                                        <div className="space-y-2 pt-2">
                                          <p className="text-xs text-muted-foreground">
                                            Created automatically when connecting. Reused across
                                            connections, not selectable as your app.
                                          </p>
                                          {dcrClients.map((app: OAuthClientOption) => (
                                            <div
                                              key={String(app.slug)}
                                              className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5"
                                            >
                                              <span className="min-w-0 flex-1">
                                                <span className="block text-sm font-medium">
                                                  {clientDisplayName(String(app.slug))}
                                                </span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                  {clientHost(app.tokenUrl)}
                                                </span>
                                              </span>
                                              {ownerDisplay.showOwnerLabels ? (
                                                <Badge variant="outline">
                                                  {ownerLabel(app.owner)}
                                                </Badge>
                                              ) : null}
                                              <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                className="shrink-0 text-destructive hover:text-destructive"
                                                onClick={() => {
                                                  const summary = clientSummaries.find(
                                                    (c: OAuthClientSummary) =>
                                                      c.owner === app.owner &&
                                                      String(c.slug) === String(app.slug),
                                                  );
                                                  if (summary) setRemovingClient(summary);
                                                }}
                                              >
                                                Remove
                                              </Button>
                                            </div>
                                          ))}
                                        </div>
                                      </CollapsibleContent>
                                    </Collapsible>
                                  </div>
                                )}
                              </div>
                            )
                          ) : (
                            <div className="space-y-2">
                              <CredentialValueFields
                                inputs={credentialInputs}
                                singleInput={singleInput}
                                showLabels={isEnvMethod}
                                affix={singleCredentialAffix}
                                allowExternalProvider={!isEnvMethod}
                                values={values}
                                onValuesChange={(next) => {
                                  setValues(next);
                                  clearKeyCheck();
                                }}
                                origin={credentialOrigin}
                                onOriginChange={(next) => {
                                  setCredentialOrigin(next);
                                  if (next === "paste") setOnePasswordItemId("");
                                  clearKeyCheck();
                                }}
                                onePasswordItemId={onePasswordItemId}
                                onOnePasswordItemIdChange={(next) => {
                                  setOnePasswordItemId(next);
                                  clearKeyCheck();
                                }}
                              />
                            </div>
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

              {/* The key check, as one request/response panel below the tabs.
              Always visible for credential methods: the request line shows
              exactly what will run (pre-seeded with the best identity-bearing
              read-only call, editable in place), Check runs it, and the
              response renders read-only (the identity pick happens on step 2
              as the display name). */}
              {showValidateStep && canCheckKey ? (
                <div className="space-y-1.5">
                  <StepHeader
                    index={2}
                    label="Check the key works"
                    hint="runs one read-only call with your key, saved as this integration's health check"
                  />
                  <RequestCheckPanel
                    candidates={healthCheckCandidates}
                    selected={hcSelected}
                    operation={hcOperation}
                    onOperationChange={(next) => {
                      setHcOperation(next);
                      setHcArgs({});
                      clearKeyCheck();
                    }}
                    configuredOperation={configuredHealthCheck?.operation ?? null}
                    args={hcArgs}
                    onArgChange={(name, value) => {
                      setHcArgs((prev) => ({ ...prev, [name]: value }));
                      clearKeyCheck();
                    }}
                    ready={
                      credentialPayloadOrigin !== null &&
                      !validating &&
                      (hasHealthCheck || hcCandidateReady)
                    }
                    validating={validating}
                    result={validationResult}
                    onCheck={() => {
                      if (hasHealthCheck) {
                        void handleValidate();
                      } else {
                        void handleCandidateProbe();
                      }
                    }}
                  />
                </div>
              ) : null}

              {/* Step 2 (credential wizard): a one-line recap of what step 1
              proved, so the key's verdict travels with the user instead of
              disappearing behind Back. */}
              {wizardActive && wizardStep === "place" && validationResult ? (
                <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <HealthStatusLine result={validationResult} />
                </div>
              ) : null}

              {/* Step 2 (credential wizard): name it and place it. The name is
              DERIVED (validating filled it from the account's identity), so
              it arrives prefilled, editable for the rare override. OAuth
              methods aren't a wizard; they show this alongside the picker. */}
              {showPlaceStep && (
                <div className="space-y-2">
                  <StepHeader
                    index={wizardActive ? 1 : 2}
                    label="Display name"
                    hint={
                      nameOptions.length > 0
                        ? "from the account your key returned, or type your own"
                        : "how you'll tell accounts apart"
                    }
                    htmlFor="connection-name"
                  />
                  {nameOptions.length > 0 ? (
                    // The response's identity fields are the options; picking
                    // one also stores its path as the check's identityField.
                    <FreeformCombobox
                      id="connection-name"
                      value={label}
                      onValueChange={(next) => {
                        const match = nameOptions.find((option) => option.value === next);
                        setLabel(next);
                        nameAutofilled.current = match !== undefined;
                        if (match && typeof match.description === "string") {
                          void handlePickIdentity(match.description, next);
                        }
                      }}
                      options={nameOptions}
                      placeholder={connectionLabelForHost(
                        "",
                        owner,
                        integrationName,
                        organizationId,
                      )}
                      emptyLabel="Type any name"
                    />
                  ) : (
                    <Input
                      id="connection-name"
                      placeholder={connectionLabelForHost(
                        "",
                        owner,
                        integrationName,
                        organizationId,
                      )}
                      value={label}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setLabel(e.target.value);
                        // A hand-typed name takes over: a later probe won't overwrite it.
                        nameAutofilled.current = false;
                      }}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    This connection will be callable as{" "}
                    <span className="font-mono text-foreground">{String(callableName)}</span>.
                  </p>
                </div>
              )}

              {/* Connection saved-to. Hidden while registering a new OAuth app
              (the connection, and where it's saved, only exists once you
              connect). Pickable everywhere else: for a PICKED OAuth app a
              Workspace (shared) app can mint a Personal OR Workspace connection,
              while a Personal app mints Personal only in cloud;
              for transparent DCR the app + connection land under the chosen
              owner; for a credential method it's the plain owner choice. */}
              {showSavedToPicker && showPlaceStep && (
                <div className="space-y-2">
                  <StepHeader index={wizardActive ? 2 : 3} label="Connection saved to" />
                  <ConnectionOwnerDropdown
                    value={savedToOwner}
                    options={savedToOptions}
                    onChange={(next: Owner) => setOwner(next)}
                    label="Saved to"
                  />
                </div>
              )}
            </div>

            {continueError ? (
              <p role="alert" className="px-1 text-xs text-destructive">
                {continueError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={close}
                disabled={submitting || oauthBusy || automaticOAuthConnecting}
              >
                {isOAuth ? "Close" : "Cancel"}
              </Button>
              {/* Footer action, in precedence order:
              - transparent CIMD (no app registration): create/reuse a public
                metadata-document client and start OAuth;
              - transparent DCR (no picker): a single Connect that runs
                probe → register → start;
              - registering a BYO app: the form owns its own submit, no footer;
              - picked BYO OAuth app: Connect with OAuth / Connect (client creds);
              - credential/no-auth method: Add connection. */}
              {cimdActive ? (
                <Button
                  type="button"
                  onClick={() => void handleCimdConnect()}
                  disabled={cimdConnecting}
                >
                  {cimdConnecting ? "Connecting…" : "Connect with OAuth"}
                </Button>
              ) : dcrActive ? (
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
              ) : wizardActive && wizardStep === "validate" ? (
                <Button
                  type="button"
                  onClick={() => {
                    if (credentialPayloadOrigin === null) {
                      setContinueError(
                        singleInput ? "Enter the key first" : "Fill in every credential field",
                      );
                      return;
                    }
                    setContinueError(null);
                    setWizardStep("place");
                  }}
                  loading={validating}
                >
                  Continue
                </Button>
              ) : (
                <>
                  {wizardActive ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setWizardStep("validate")}
                      disabled={submitting}
                    >
                      Back
                    </Button>
                  ) : null}
                  <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
                    {submitting ? "Adding…" : "Add connection"}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        )}

        {/* Remove-app confirmation — layered over the picker. Renders into its
            own portal, so it sits cleanly above the modal regardless of which
            sub-view is active. */}
        {removingClient ? (
          <RemoveOAuthAppDialog
            client={removingClient}
            connections={connectionsUsingClient(usage, removingClient)}
            onConfirm={() => void handleRemoveApp(removingClient)}
            onClose={() => setRemovingClient(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
