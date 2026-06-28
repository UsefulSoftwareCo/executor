import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { cancelOAuth, oauthConnectionCompleted, startOAuth } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { messageFromExit, messageFromUnknown, useReportHandledError } from "../api/error-reporting";
import {
  openOAuthPopup,
  openOAuthSystemBrowser,
  reserveOAuthPopup,
  type OAuthPopupResult,
} from "../api/oauth-popup";
import { connectionWriteKeys } from "../api/reactivity-keys";
import { getActiveOrgSlug } from "../api/server-connection";

type DesktopBridge = {
  readonly openExternal: (url: string) => Promise<void>;
};

const getDesktopBridge = (): DesktopBridge | null => {
  if (typeof window === "undefined") return null;
  const candidate = (window as { readonly executor?: Partial<DesktopBridge> }).executor;
  return candidate && typeof candidate.openExternal === "function"
    ? // oxlint-disable-next-line executor/no-double-cast -- boundary: narrowed by the typeof guard above
      (candidate as DesktopBridge)
    : null;
};
import { Button } from "../components/button";
import {
  OAUTH_POPUP_MESSAGE_TYPE,
  OAuthState,
  type AuthTemplateSlug,
  type ConnectionName,
  type IntegrationSlug,
  type OAuthClientSlug,
  type Owner,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// OAuth sign-in (v2). A registered OAuth client (`oauth.createClient`) is run by
// `oauth.start` for one integration, minting an owner-scoped Connection. `start`
// either returns the connection inline (`status: "connected"`) or a redirect
// (`status: "redirect"` with an `authorizationUrl` + `state`); the popup
// completes the redirect via the server `/oauth/callback`, then posts the result
// back. `state` is the correlation token (the v1 session id).
//
// NOTE(v2): the server-side flow is stubbed (D18). The shapes below track the
// v2 contract so this UI compiles; the plugin `/react` wave wires the buttons.
// ---------------------------------------------------------------------------

export type OAuthCompletionPayload = {
  readonly connection: ConnectionName;
};

export type OAuthStartPayload = {
  /** Registered OAuth client slug to run. */
  readonly client: OAuthClientSlug;
  /** Owner of `client` (a Personal connection may use a shared Workspace app). */
  readonly clientOwner: Owner;
  readonly owner: Owner;
  /** Name for the connection the flow mints. */
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
  readonly identityLabel?: string;
  readonly redirectUri?: string;
};

export type StartOAuthPopupInput<TPayload extends OAuthCompletionPayload> = {
  readonly payload: OAuthStartPayload;
  readonly onSuccess: (payload: TPayload) => void | Promise<void>;
  readonly onError?: (error: string) => void;
  readonly onAuthorizationStarted?: (result: OAuthAuthorizationStartResult) => void;
};

export type OAuthAuthorizationStartResult = {
  /** OAuth correlation token (was the v1 session id). */
  readonly state: string;
  readonly authorizationUrl: string | null;
};

class OAuthAuthorizationStartError extends Data.TaggedError("OAuthAuthorizationStartError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type StartOAuthAuthorizationInput<TPayload extends OAuthCompletionPayload> = {
  readonly owner: Owner;
  readonly run: () => Promise<OAuthAuthorizationStartResult>;
  readonly onSuccess: (payload: TPayload) => void | Promise<void>;
  readonly onError?: (error: string, details?: string) => void;
  readonly onAuthorizationStarted?: (result: OAuthAuthorizationStartResult) => void;
  readonly reportMetadata?: Record<string, string | number | boolean | null | undefined>;
};

export function oauthCallbackUrl(path = "/api/oauth/callback"): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH = "/api/oauth/client-id-metadata/default.json";
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_LOCAL_PATH =
  "/api/oauth/client-id-metadata/local.json";

const configuredClientIdMetadataBaseUrl = (): string | undefined => {
  const env = (
    import.meta as ImportMeta & {
      readonly env?: Record<string, string | undefined>;
    }
  ).env;
  const value = env?.VITE_EXECUTOR_CIMD_CLIENT_ID_METADATA_BASE_URL?.trim();
  return value ? value : undefined;
};

export function oauthClientIdMetadataDocumentUrl(options?: {
  readonly hostedBaseUrl?: string | null;
  readonly path?: string;
}): string {
  const hostedBaseUrl = options?.hostedBaseUrl ?? configuredClientIdMetadataBaseUrl();
  if (hostedBaseUrl) {
    return new URL(OAUTH_CLIENT_ID_METADATA_DOCUMENT_LOCAL_PATH, hostedBaseUrl).toString();
  }

  const defaultPath = options?.path ?? OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH;
  if (typeof window === "undefined") return defaultPath;
  const orgSlug = getActiveOrgSlug();
  const metadataPath = orgSlug
    ? `/api/oauth/client-id-metadata/${encodeURIComponent(orgSlug)}.json`
    : defaultPath;
  const url = new URL(metadataPath, window.location.origin);
  return url.toString();
}

export function useOAuthPopupFlow<
  TPayload extends OAuthCompletionPayload = OAuthCompletionPayload,
>(options: {
  readonly popupName: string;
  readonly callbackPath?: string;
  readonly noAuthorizationUrlMessage?: string;
  readonly popupBlockedMessage?: string;
  readonly popupClosedMessage?: string;
  readonly detectPopupClosed?: boolean;
  readonly startErrorMessage?: string;
}) {
  const {
    detectPopupClosed = true,
    callbackPath,
    noAuthorizationUrlMessage,
    popupBlockedMessage,
    popupClosedMessage,
    popupName,
    startErrorMessage,
  } = options;
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doCancelOAuth = useAtomSet(cancelOAuth, { mode: "promiseExit" });
  const doOAuthConnectionCompleted = useAtomSet(oauthConnectionCompleted, { mode: "promiseExit" });
  const reportHandledError = useReportHandledError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<{ readonly state: string } | null>(null);

  const cancelSession = useCallback(
    (state: string) => {
      void doCancelOAuth({ payload: { state: OAuthState.make(state) } });
    },
    [doCancelOAuth],
  );

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    cleanupRef.current?.();
    cleanupRef.current = null;
    sessionRef.current = null;
    if (session) cancelSession(session.state);
    setBusy(false);
  }, [cancelSession]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      cleanupRef.current?.();
      cleanupRef.current = null;
      sessionRef.current = null;
      if (session) cancelSession(session.state);
    },
    [cancelSession],
  );

  const openAuthorization = useCallback(
    async (input: StartOAuthAuthorizationInput<TPayload>) => {
      cancel();
      setBusy(true);
      setError(null);
      const desktopBridge = getDesktopBridge();
      // Desktop hosts open the auth URL in the user's real browser, so we skip
      // the in-page popup reservation entirely and rely on the polling channel
      // for the result.
      const reservedPopup = desktopBridge ? null : reserveOAuthPopup({ popupName });
      if (!desktopBridge && !reservedPopup) {
        const message = popupBlockedMessage ?? "Sign-in popup was blocked by the browser";
        trackEvent("oauth_popup_blocked");
        setBusy(false);
        setError(message);
        input.onError?.(message);
        return;
      }
      const startExit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: input.run,
          catch: (cause) =>
            new OAuthAuthorizationStartError({
              cause,
              message: messageFromUnknown(cause, startErrorMessage ?? "Failed to start sign-in"),
            }),
        }),
      );
      if (Exit.isFailure(startExit)) {
        const message = messageFromExit(startExit, startErrorMessage ?? "Failed to start sign-in");
        reportHandledError(startExit.cause, {
          surface: "oauth",
          action: "start",
          message,
          metadata: input.reportMetadata,
        });
        reservedPopup?.popup.close();
        setBusy(false);
        setError(message);
        input.onError?.(message);
        return;
      }
      const response = startExit.value;
      if (response.authorizationUrl === null) {
        const message =
          noAuthorizationUrlMessage ?? "OAuth start did not produce an authorization URL";
        reservedPopup?.popup.close();
        setBusy(false);
        setError(message);
        input.onError?.(message);
        return;
      }

      sessionRef.current = { state: response.state };
      input.onAuthorizationStarted?.(response);
      const handleResult = async (result: OAuthPopupResult<TPayload>) => {
        cleanupRef.current = null;
        sessionRef.current = null;

        if (!result.ok) {
          trackEvent("oauth_completed", { success: false });
          setBusy(false);
          setError(result.error);
          input.onError?.(result.error, result.errorDetails);
          return;
        }

        const refreshExit = await doOAuthConnectionCompleted({
          reactivityKeys: connectionWriteKeys,
        });
        if (Exit.isFailure(refreshExit)) {
          const message = messageFromExit(refreshExit, "Failed to refresh connection");
          reportHandledError(refreshExit.cause, {
            surface: "oauth",
            action: "refresh_connection",
            message,
            metadata: input.reportMetadata,
          });
          trackEvent("oauth_completed", { success: false });
          setBusy(false);
          setError(message);
          input.onError?.(message);
          return;
        }

        const persistenceError = await Promise.resolve(input.onSuccess(result)).then(
          () => null,
          (cause: unknown) => cause,
        );
        if (persistenceError !== null) {
          const message = messageFromUnknown(persistenceError, "Failed to save connection");
          reportHandledError(persistenceError, {
            surface: "oauth",
            action: "persist_connection",
            message,
            metadata: input.reportMetadata,
          });
          trackEvent("oauth_completed", { success: false });
          setBusy(false);
          setError(message);
          input.onError?.(message);
          return;
        }
        trackEvent("oauth_completed", { success: true });
        setBusy(false);
      };
      const handleClosed = () => {
        cleanupRef.current = null;
        sessionRef.current = null;
        // `popup.closed` is advisory: COOP redirects can make a live popup
        // appear closed to the opener. Keep server OAuth state alive for a
        // callback or TTL cleanup; only explicit cancel deletes the session.
        const message =
          popupClosedMessage ?? "Sign-in cancelled - popup was closed before completing the flow.";
        trackEvent("oauth_completed", { success: false });
        setBusy(false);
        setError(message);
        input.onError?.(message);
      };
      const handleOpenFailed = () => {
        cleanupRef.current = null;
        sessionRef.current = null;
        cancelSession(response.state);
        const message = popupBlockedMessage ?? "Sign-in popup was blocked by the browser";
        trackEvent("oauth_completed", { success: false });
        setBusy(false);
        setError(message);
        input.onError?.(message);
      };

      cleanupRef.current = desktopBridge
        ? openOAuthSystemBrowser<TPayload>({
            url: response.authorizationUrl,
            sessionId: response.state,
            openExternal: desktopBridge.openExternal,
            onResult: (result) => void handleResult(result),
            onOpenFailed: handleOpenFailed,
            onTimeout: handleClosed,
          })
        : openOAuthPopup<TPayload>({
            url: response.authorizationUrl,
            popupName,
            channelName: OAUTH_POPUP_MESSAGE_TYPE,
            expectedSessionId: response.state,
            reservedPopup: reservedPopup ?? undefined,
            closedPollMs: detectPopupClosed ? undefined : null,
            onResult: (result) => void handleResult(result),
            onClosed: handleClosed,
            onOpenFailed: handleOpenFailed,
          });
    },
    [
      cancel,
      cancelSession,
      detectPopupClosed,
      doOAuthConnectionCompleted,
      noAuthorizationUrlMessage,
      popupBlockedMessage,
      popupClosedMessage,
      popupName,
      reportHandledError,
      startErrorMessage,
    ],
  );

  const start = useCallback(
    async (input: StartOAuthPopupInput<TPayload>) => {
      await openAuthorization({
        owner: input.payload.owner,
        onSuccess: input.onSuccess,
        onError: input.onError,
        onAuthorizationStarted: input.onAuthorizationStarted,
        reportMetadata: {
          client: String(input.payload.client),
          integration: String(input.payload.integration),
          name: String(input.payload.name),
          owner: input.payload.owner,
        },
        run: () =>
          doStartOAuth({
            payload: {
              client: input.payload.client,
              clientOwner: input.payload.clientOwner,
              owner: input.payload.owner,
              name: input.payload.name,
              integration: input.payload.integration,
              template: input.payload.template,
              identityLabel: input.payload.identityLabel,
              redirectUri: input.payload.redirectUri ?? oauthCallbackUrl(callbackPath),
            },
          }).then((exit) =>
            Exit.isSuccess(exit)
              ? // The redirect branch carries `authorizationUrl` + `state`; the
                // inline "connected" (client_credentials) branch has no URL to
                // open and no redirect, so `state` is intentionally empty — it
                // is never read for an already-minted connection.
                exit.value.status === "redirect"
                ? { state: exit.value.state, authorizationUrl: exit.value.authorizationUrl }
                : { state: "", authorizationUrl: null }
              : Effect.runPromise(
                  Effect.fail({
                    message: messageFromExit(exit, startErrorMessage ?? "Failed to start sign-in"),
                  }),
                ),
          ),
      });
    },
    [callbackPath, doStartOAuth, openAuthorization, startErrorMessage],
  );

  return {
    busy,
    error,
    setError,
    start,
    openAuthorization,
    cancel,
  };
}

export function OAuthSignInButton(props: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly isConnected: boolean;
  readonly onSignIn: () => void;
  readonly reconnectingLabel?: string;
  readonly signingInLabel?: string;
  readonly reconnectLabel?: string;
  readonly signInLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {props.error && <span className="text-xs text-destructive">{props.error}</span>}
      <Button variant="outline" size="sm" onClick={props.onSignIn} disabled={props.busy}>
        {props.busy
          ? props.isConnected
            ? (props.reconnectingLabel ?? "Reconnecting...")
            : (props.signingInLabel ?? "Signing in...")
          : props.isConnected
            ? (props.reconnectLabel ?? "Reconnect")
            : (props.signInLabel ?? "Sign in")}
      </Button>
    </div>
  );
}
