import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { IntegrationSlug, type Connection, type Owner } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";
import { toast } from "sonner";

import {
  addConnectionOptimistic,
  connectionsForIntegrationAtom,
  refreshConnection,
  removeConnectionOptimistic,
  startOAuth,
} from "../api/atoms";
import { connectionWriteKeys } from "../api/reactivity-keys";
import { HEALTH_INDICATOR_COLOR, HEALTH_STATUS_LABEL } from "../lib/health-display";
import { useConnectionHealth } from "../lib/use-connection-health";
import { messageFromExit } from "../api/error-reporting";
import { ownerLabel, useOwnerDisplay } from "../api/owner-display";
import { trackEvent } from "../api/analytics";
import type { AuthMethod } from "../lib/auth-placements";
import {
  connectionNeedsReconsent,
  oauthReconnectPayload,
  reconnectMode,
  reconsentRequiredScopes,
} from "../plugins/oauth-reconnect";
import { useOAuthPopupFlow } from "../plugins/oauth-sign-in";
import { AddAccountModal } from "./add-account-modal";
import { ConnectionEditSheet } from "./metadata-edit-sheet";
import type { CreateCustomMethod } from "./add-custom-method-modal";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "./card-stack";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

// ---------------------------------------------------------------------------
// Accounts section — the integration's connections, grouped by owner.
//
// Credentials are IMMUTABLE (no method switch); the editable surface is the
// user-curated metadata — description (agent-visible) and account label — via
// the per-row Edit sheet. "+ Add connection" opens the create modal. When both
// owners have zero accounts, the section collapses to a single empty CTA.
// ---------------------------------------------------------------------------

const OWNERS: readonly Owner[] = ["org", "user"];

function AccountRow(props: {
  readonly connection: Connection;
  /** The integration declares scopes this connection was not granted — it must
   *  reconnect to grant the newly-needed access (e.g. after a service was added). */
  readonly needsReconsent: boolean;
  readonly showOwnerLabel: boolean;
  readonly onEdit: () => void;
  readonly onReconnect: () => void;
  readonly onRemove: () => void;
}) {
  const { connection, needsReconsent } = props;
  const [checking, setChecking] = useState(false);

  // The status renders WITHOUT any clicking: every checkHealth run persists its
  // verdict on the connection row, so the list answers "has this expired?" at a
  // glance. A live check from this session takes precedence. We deliberately do
  // NOT derive expiry from the stored `expiresAt`: that's the access-token
  // lifetime, which refreshes, so a passive countdown means nothing.
  //
  // Health checks are AUTOMATIC: the hook revalidates on mount, stale-while-
  // revalidate style (shared with the integrations-list summary), and the
  // persisted verdict renders instantly while the probe corrects it in place.
  const { probe, status, runCheck } = useConnectionHealth(connection);
  const indicator = HEALTH_INDICATOR_COLOR[status];

  // Prefer a probed identity (the live account), then the stored label, then the
  // connection name. The probe is the whole point: it shows WHICH account this is.
  const identity =
    (probe?.identity && probe.identity.length > 0 ? probe.identity : null) ??
    (connection.identityLabel && connection.identityLabel.length > 0
      ? connection.identityLabel
      : null);
  const displayLabel = identity ?? String(connection.name);

  const expired = status === "expired";

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    const exit = await runCheck();
    setChecking(false);
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Health check failed"));
      return;
    }
    // The hook already folded the fresh probe into the live state.
    if (exit.value.status === "healthy") {
      toast.success(
        exit.value.identity ? `Healthy: ${exit.value.identity}` : "Connection is healthy",
      );
    } else if (exit.value.status === "expired") {
      toast.error("Connection expired, reconnect to restore access");
    } else if (exit.value.status === "degraded") {
      toast.warning(exit.value.detail ?? "Connection check returned an error");
    } else {
      toast.message("No health check is configured for this integration");
    }
  };

  return (
    <CardStackEntry className="flex-wrap items-start">
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex min-w-0 items-center gap-2">
          <span
            aria-label={`Status: ${HEALTH_STATUS_LABEL[status]}`}
            title={HEALTH_STATUS_LABEL[status]}
            className={`size-2 shrink-0 rounded-full ${indicator.dot}`}
          />
          <span className="truncate">{displayLabel}</span>
          {expired ? (
            <Badge variant="destructive" className="shrink-0">
              Expired
            </Badge>
          ) : null}
          {needsReconsent ? (
            <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
              Reconnect to grant access
            </Badge>
          ) : null}
        </CardStackEntryTitle>
        {connection.description && connection.description.length > 0 ? (
          <CardStackEntryDescription className="mt-1 text-xs">
            {connection.description}
          </CardStackEntryDescription>
        ) : null}
        {needsReconsent ? (
          <CardStackEntryDescription className="mt-1 text-xs text-muted-foreground">
            This connection wasn't granted all the access this integration now needs.
          </CardStackEntryDescription>
        ) : null}
      </CardStackEntryContent>
      <CardStackEntryActions className="self-start pt-0.5">
        {props.showOwnerLabel ? (
          <Badge variant="outline">{ownerLabel(connection.owner)}</Badge>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="size-3">
                <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="13" r="1.2" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              className="text-sm"
              disabled={checking}
              onClick={() => void handleCheck()}
            >
              {checking ? "Checking…" : "Check now"}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-sm" onClick={props.onEdit}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem className="text-sm" onClick={props.onReconnect}>
              Reconnect
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" className="text-sm" onClick={props.onRemove}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

function OwnerAccounts(props: {
  readonly integration: IntegrationSlug;
  readonly owner: Owner;
  readonly showOwnerLabels: boolean;
  readonly methods: readonly AuthMethod[];
  readonly onEdit: (connection: Connection) => void;
  readonly onDcrReconnect: (connection: Connection) => void;
  /** The integration's declared oauth scopes — compared against each connection's
   *  granted `oauthScope` to flag connections that must reconnect for new access. */
  readonly declaredScopes: readonly string[] | undefined;
}) {
  const { integration, owner } = props;
  const connections = useAtomValue(connectionsForIntegrationAtom({ integration, owner }));
  const doRemove = useAtomSet(removeConnectionOptimistic(owner), {
    mode: "promiseExit",
  });
  const doRefresh = useAtomSet(refreshConnection, { mode: "promiseExit" });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  // OAuth connections re-CONSENT on Reconnect (a token refresh cannot widen
  // scopes and fails with no refresh token), so they re-run the OAuth flow. The
  // popup flow re-mints the SAME connection (owner/integration/name) with a
  // fresh refresh token + the widened scope union. Static creds keep the refresh
  // path. One flow hosted per owner-group is enough — Reconnect is one-at-a-time.
  const oauthPopup = useOAuthPopupFlow({
    popupName: "reconnect-oauth",
    detectPopupClosed: false,
    startErrorMessage: "Failed to reconnect",
  });

  const rows: readonly Connection[] = AsyncResult.isSuccess(connections) ? connections.value : [];
  if (rows.length === 0) return null;

  const handleReconnect = async (connection: Connection) => {
    // OAuth connection → re-run the OAuth flow (re-consent + widened scopes +
    // fresh refresh token); re-minting overwrites the existing connection.
    if (reconnectMode(connection) === "oauth") {
      const method = props.methods.find(
        (candidate: AuthMethod) =>
          candidate.kind === "oauth" && String(candidate.template) === String(connection.template),
      );
      if (
        method?.oauth?.supportsDynamicRegistration === true ||
        method?.oauth?.discoveryUrl != null
      ) {
        props.onDcrReconnect(connection);
        return;
      }
      const payload = oauthReconnectPayload(connection);
      if (payload === null) return;
      // `oauth.start` discriminates the grant: client_credentials mints inline
      // (`status: "connected"`, no authorization URL) while authorization_code
      // returns a redirect the popup must complete. The popup hook only handles
      // the redirect grant (a null authorization URL is an error there), so we
      // start once here and branch — inline-connected is handled directly,
      // redirect hands the already-issued URL to the popup. Both re-mint the
      // SAME connection (owner/integration/name).
      const startExit = await doStartOAuth({
        payload,
        reactivityKeys: connectionWriteKeys,
      });
      if (Exit.isFailure(startExit)) {
        toast.error(messageFromExit(startExit, "Failed to reconnect"));
        trackEvent("connection_reconnected", {
          integration_slug: String(connection.integration),
          owner: connection.owner,
          success: false,
        });
        return;
      }
      const started = startExit.value;
      if (started.status === "connected") {
        toast.success("Reconnected");
        trackEvent("connection_reconnected", {
          integration_slug: String(connection.integration),
          owner: connection.owner,
          success: true,
        });
        return;
      }
      void oauthPopup.openAuthorization({
        owner: payload.owner,
        run: () =>
          Promise.resolve({
            state: started.state,
            authorizationUrl: started.authorizationUrl,
          }),
        onSuccess: () => {
          toast.success("Reconnected");
          trackEvent("connection_reconnected", {
            integration_slug: String(connection.integration),
            owner: connection.owner,
            success: true,
          });
        },
        onError: () => {
          toast.error("Failed to reconnect");
          trackEvent("connection_reconnected", {
            integration_slug: String(connection.integration),
            owner: connection.owner,
            success: false,
          });
        },
      });
      return;
    }
    // Non-OAuth connection → token refresh (the original path).
    const exit = await doRefresh({
      params: {
        owner: connection.owner,
        integration: connection.integration,
        name: connection.name,
      },
      reactivityKeys: connectionWriteKeys,
    });
    trackEvent("connection_reconnected", {
      integration_slug: String(connection.integration),
      owner: connection.owner,
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Failed to reconnect"));
    }
  };

  const handleRemove = async (connection: Connection) => {
    const exit = await doRemove({
      params: {
        owner: connection.owner,
        integration: connection.integration,
        name: connection.name,
      },
      reactivityKeys: connectionWriteKeys,
    });
    trackEvent("connection_removed", {
      integration_slug: String(connection.integration),
      owner: connection.owner,
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Failed to remove connection"));
    }
  };

  return (
    <CardStack>
      {props.showOwnerLabels ? <CardStackHeader>{ownerLabel(owner)}</CardStackHeader> : null}
      <CardStackContent>
        {rows.map((connection: Connection) => (
          <AccountRow
            key={`${connection.owner}:${connection.integration}:${connection.name}`}
            connection={connection}
            needsReconsent={connectionNeedsReconsent(connection, props.declaredScopes)}
            showOwnerLabel={props.showOwnerLabels}
            onEdit={() => props.onEdit(connection)}
            onReconnect={() => void handleReconnect(connection)}
            onRemove={() => void handleRemove(connection)}
          />
        ))}
      </CardStackContent>
    </CardStack>
  );
}

export function AccountsSection(props: {
  readonly integration: IntegrationSlug;
  readonly integrationName: string;
  readonly methods: readonly AuthMethod[];
  readonly accountHandoff?: IntegrationAccountHandoff | null;
  /** When provided, Add connection shows a "+ Custom method" row. The plugin binds
   *  this to its own configure mutation. Omitted for plugins with fixed auth. */
  readonly createCustomMethod?: CreateCustomMethod;
  readonly removeCustomMethod?: (method: AuthMethod) => Promise<boolean>;
}) {
  const {
    integration,
    integrationName,
    methods,
    accountHandoff,
    createCustomMethod,
    removeCustomMethod,
  } = props;
  const [adding, setAdding] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(null);
  const [reconnectHandoff, setReconnectHandoff] = useState<IntegrationAccountHandoff | null>(null);
  const ownerDisplay = useOwnerDisplay();
  const canAddConnection = methods.length > 0 || createCustomMethod !== undefined;

  useEffect(() => {
    if (accountHandoff) {
      setAdding(true);
    }
  }, [accountHandoff]);

  // The integration's declared oauth scopes — what connections need granted. A
  // connection granted fewer is flagged to reconnect (e.g. after a service was
  // added widened the consent).
  //
  // Spec-derived oauth scopes are the full per-operation catalog union (e.g. an
  // OpenAPI source like PostHog declares hundreds of scopes). Those are requested
  // broadly but not individually required: a provider that narrows the grant to
  // the user's actual access is healthy, not in need of reconnect. So only treat
  // CUSTOM (user-configured) scopes as required here; never the spec catalog.
  const oauthMethod = methods.find((m: AuthMethod) => m.kind === "oauth");
  const declaredScopes = reconsentRequiredScopes(oauthMethod);

  // Read both owners to decide between the grouped view and the empty CTA. The
  // grouped sub-components re-read these (effect-atom dedupes) and self-hide.
  const orgConnections = useAtomValue(connectionsForIntegrationAtom({ integration, owner: "org" }));
  const userConnections = useAtomValue(
    connectionsForIntegrationAtom({ integration, owner: "user" }),
  );

  // Mount the optimistic-add atoms so the section participates in the same
  // optimistic surface the modal writes through (keeps the registry warm).
  useAtomSet(addConnectionOptimistic("org"));
  useAtomSet(addConnectionOptimistic("user"));

  const totalCount = useMemo(() => {
    const orgRows = AsyncResult.isSuccess(orgConnections) ? orgConnections.value.length : 0;
    const userRows = AsyncResult.isSuccess(userConnections) ? userConnections.value.length : 0;
    return orgRows + userRows;
  }, [orgConnections, userConnections]);

  const loading = !AsyncResult.isSuccess(orgConnections) && !AsyncResult.isSuccess(userConnections);

  // When there are zero connections the dashed empty-state card below carries
  // its own "Add connection" CTA, so the header button would be a redundant
  // second copy of the same action. Show the header button only outside that
  // state (populated, or still loading).
  const showEmptyState = !loading && totalCount === 0;

  const openAddConnection = () => {
    trackEvent("connection_add_opened", {
      integration_slug: String(integration),
      has_oauth_method: methods.some((m: AuthMethod) => m.kind === "oauth"),
      has_api_key_method: methods.some((m: AuthMethod) => m.kind !== "oauth" && m.kind !== "none"),
    });
    setAdding(true);
  };

  const modalState = reconnectHandoff ?? accountHandoff;
  const modal = (
    <AddAccountModal
      integration={integration}
      integrationName={integrationName}
      methods={methods}
      open={adding || reconnectHandoff !== null}
      onOpenChange={(open: boolean) => {
        setAdding(open);
        if (!open) setReconnectHandoff(null);
      }}
      initialState={modalState}
      createCustomMethod={createCustomMethod}
      removeCustomMethod={removeCustomMethod}
    />
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Connections
        </h3>
        {!showEmptyState ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openAddConnection}
            disabled={!canAddConnection}
          >
            Add connection
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6">
          <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Loading accounts…</p>
        </div>
      ) : showEmptyState ? (
        <div className="rounded-lg border border-dashed border-border/60 px-6 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No connections yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a connection to make this integration's tools available.
          </p>
          <Button
            type="button"
            className="mt-4"
            size="sm"
            onClick={openAddConnection}
            disabled={!canAddConnection}
          >
            Add connection
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {OWNERS.map((owner: Owner) => (
            <OwnerAccounts
              key={owner}
              integration={integration}
              owner={owner}
              showOwnerLabels={ownerDisplay.showOwnerLabels}
              methods={methods}
              onEdit={setEditingConnection}
              onDcrReconnect={(connection: Connection) => {
                if (connection.oauthClient == null) return;
                setReconnectHandoff({
                  key: `reconnect:${connection.owner}:${String(connection.integration)}:${String(
                    connection.name,
                  )}:${Date.now()}`,
                  owner: connection.owner,
                  template: String(connection.template),
                  label: String(connection.name),
                  ...(connection.identityLabel != null
                    ? { identityLabel: connection.identityLabel }
                    : {}),
                  oauthClient: {
                    action: "reconnect",
                    slug: String(connection.oauthClient),
                    owner: connection.oauthClientOwner ?? connection.owner,
                  },
                });
              }}
              declaredScopes={declaredScopes}
            />
          ))}
        </div>
      )}

      {modal}

      <ConnectionEditSheet
        connection={editingConnection}
        onOpenChange={(open: boolean) => {
          if (!open) setEditingConnection(null);
        }}
      />
    </section>
  );
}
