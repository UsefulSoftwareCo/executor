import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { cancelOAuth, startOAuth } from "../api/atoms";
import { messageFromExit, messageFromUnknown, useReportHandledError } from "../api/error-reporting";
import {
  openOAuthPopup,
  openOAuthSystemBrowser,
  reserveOAuthPopup,
  type OAuthPopupResult,
} from "../api/oauth-popup";

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
  ConnectionId,
  ScopeId,
  type OAuthStrategy,
  type SecretBackedValue,
} from "@executor-js/sdk";

export type OAuthCompletionPayload = {
  readonly connectionId: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
};

export type OAuthStartPayload = {
  readonly endpoint: string;
  readonly headers?: Record<string, SecretBackedValue>;
  readonly queryParams?: Record<string, SecretBackedValue>;
  readonly redirectUrl?: string;
  readonly connectionId: string;
  readonly tokenScope: string;
  readonly strategy: OAuthStrategy;
  readonly pluginId: string;
  readonly identityLabel?: string;
};

export type StartOAuthPopupInput<TPayload extends OAuthCompletionPayload> = {
  readonly payload: OAuthStartPayload;
  readonly onSuccess: (payload: TPayload) => void | Promise<void>;
  readonly onError?: (error: string) => void;
  readonly onAuthorizationStarted?: (result: OAuthAuthorizationStartResult) => void;
};

export type OAuthAuthorizationStartResult = {
  readonly sessionId: string;
  readonly authorizationUrl: string | null;
};

class OAuthAuthorizationStartError extends Data.TaggedError("OAuthAuthorizationStartError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type StartOAuthAuthorizationInput<TPayload extends OAuthCompletionPayload> = {
  readonly tokenScope: string;
  readonly run: () => Promise<OAuthAuthorizationStartResult>;
  readonly onSuccess: (payload: TPayload) => void | Promise<void>;
  readonly onError?: (error: string) => void;
  readonly onAuthorizationStarted?: (result: OAuthAuthorizationStartResult) => void;
  readonly reportMetadata?: Record<string, string | number | boolean | null | undefined>;
};

export function oauthCallbackUrl(path = "/api/oauth/callback"): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

export function oauthConnectionId(input: {
  readonly pluginId: string;
  readonly namespace: string;
  readonly fallback?: string;
}): string {
  const namespace = input.namespace || input.fallback || "default";
  return `${input.pluginId}-oauth2-${namespace}`;
}

const oauthRouteParamsForTokenScope = (
  tokenScope: string | ScopeId,
): { readonly scopeId: ScopeId } => ({
  scopeId: ScopeId.make(String(tokenScope)),
});

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
    callbackPath,
    detectPopupClosed = true,
    noAuthorizationUrlMessage,
    popupBlockedMessage,
    popupClosedMessage,
    popupName,
    startErrorMessage,
  } = options;
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doCancelOAuth = useAtomSet(cancelOAuth, { mode: "promiseExit" });
  const reportHandledError = useReportHandledError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<{
    readonly sessionId: string;
    readonly tokenScope: string;
  } | null>(null);

  const cancelSession = useCallback(
    (sessionId: string, tokenScope: string) => {
      void doCancelOAuth({
        params: oauthRouteParamsForTokenScope(tokenScope),
        payload: { sessionId, tokenScope },
      });
    },
    [doCancelOAuth],
  );

  const cancel = useCallback(() => {
    const sessionId = sessionRef.current;
    cleanupRef.current?.();
    cleanupRef.current = null;
    sessionRef.current = null;
    if (sessionId) cancelSession(sessionId.sessionId, sessionId.tokenScope);
    setBusy(false);
  }, [cancelSession]);

  useEffect(
    () => () => {
      const sessionId = sessionRef.current;
      cleanupRef.current?.();
      cleanupRef.current = null;
      sessionRef.current = null;
      if (sessionId) cancelSession(sessionId.sessionId, sessionId.tokenScope);
    },
    [cancelSession],
  );

  const openAuthorization = useCallback(
    async (input: StartOAuthAuthorizationInput<TPayload>) => {
      cancel();
      setBusy(true);
      setError(null);
      const desktopBridge = getDesktopBridge();
      // Desktop hosts open the auth URL in the user's real browser, so
      // we skip the in-page popup reservation entirely and rely on the
      // /api/oauth/await/:sessionId polling channel for the result.
      const reservedPopup = desktopBridge ? null : reserveOAuthPopup({ popupName });
      if (!desktopBridge && !reservedPopup) {
        const message = popupBlockedMessage ?? "Sign-in popup was blocked by the browser";
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

      sessionRef.current = {
        sessionId: response.sessionId,
        tokenScope: input.tokenScope,
      };
      input.onAuthorizationStarted?.(response);
      const handleResult = async (result: OAuthPopupResult<TPayload>) => {
        cleanupRef.current = null;
        sessionRef.current = null;

        if (!result.ok) {
          setBusy(false);
          setError(result.error);
          input.onError?.(result.error);
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
          setBusy(false);
          setError(message);
          input.onError?.(message);
          return;
        }
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
        setBusy(false);
        setError(message);
        input.onError?.(message);
      };
      const handleOpenFailed = () => {
        cleanupRef.current = null;
        sessionRef.current = null;
        cancelSession(response.sessionId, input.tokenScope);
        const message = popupBlockedMessage ?? "Sign-in popup was blocked by the browser";
        setBusy(false);
        setError(message);
        input.onError?.(message);
      };

      cleanupRef.current = desktopBridge
        ? openOAuthSystemBrowser<TPayload>({
            url: response.authorizationUrl,
            sessionId: response.sessionId,
            openExternal: desktopBridge.openExternal,
            onResult: (result) => void handleResult(result),
            onOpenFailed: handleOpenFailed,
            onTimeout: handleClosed,
          })
        : openOAuthPopup<TPayload>({
            url: response.authorizationUrl,
            popupName,
            channelName: OAUTH_POPUP_MESSAGE_TYPE,
            expectedSessionId: response.sessionId,
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
        tokenScope: input.payload.tokenScope,
        onSuccess: input.onSuccess,
        onError: input.onError,
        onAuthorizationStarted: input.onAuthorizationStarted,
        reportMetadata: {
          pluginId: input.payload.pluginId,
          connectionId: input.payload.connectionId,
          tokenScope: input.payload.tokenScope,
        },
        run: () =>
          doStartOAuth({
            params: oauthRouteParamsForTokenScope(input.payload.tokenScope),
            payload: {
              ...input.payload,
              redirectUrl: input.payload.redirectUrl ?? oauthCallbackUrl(callbackPath),
            },
          }).then((exit) =>
            Exit.isSuccess(exit)
              ? exit.value
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

export function SourceOAuthSignInButton(props: {
  readonly popupName: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly fallbackNamespace: string;
  readonly endpoint: string;
  readonly tokenScope: ScopeId;
  readonly connectionId: string | null;
  readonly sourceLabel: string;
  readonly headers?: Record<string, SecretBackedValue>;
  readonly queryParams?: Record<string, SecretBackedValue>;
  readonly isConnected: boolean;
  readonly onConnected: (connectionId: ConnectionId) => void | Promise<void>;
  readonly detectPopupClosed?: boolean;
  readonly reconnectingLabel?: string;
  readonly signingInLabel?: string;
}) {
  const {
    connectionId,
    detectPopupClosed,
    endpoint,
    fallbackNamespace,
    headers,
    isConnected,
    namespace,
    onConnected,
    pluginId,
    popupName,
    queryParams,
    reconnectingLabel,
    signingInLabel,
    sourceLabel,
    tokenScope,
  } = props;
  const oauth = useOAuthPopupFlow({
    popupName,
    detectPopupClosed,
  });

  const handleSignIn = useCallback(async () => {
    await oauth.start({
      payload: {
        endpoint,
        redirectUrl: oauthCallbackUrl(),
        connectionId:
          connectionId ??
          oauthConnectionId({
            pluginId,
            namespace,
            fallback: fallbackNamespace,
          }),
        headers,
        queryParams,
        tokenScope,
        strategy: { kind: "dynamic-dcr" },
        pluginId,
        identityLabel: sourceLabel,
      },
      onSuccess: async (result: OAuthCompletionPayload) => {
        await onConnected(ConnectionId.make(result.connectionId));
      },
    });
  }, [
    connectionId,
    endpoint,
    fallbackNamespace,
    headers,
    namespace,
    oauth,
    onConnected,
    pluginId,
    queryParams,
    sourceLabel,
    tokenScope,
  ]);

  return (
    <OAuthSignInButton
      busy={oauth.busy}
      error={oauth.error}
      isConnected={isConnected}
      onSignIn={() => void handleSignIn()}
      reconnectingLabel={reconnectingLabel}
      signingInLabel={signingInLabel}
    />
  );
}
