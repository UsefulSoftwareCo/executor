import * as React from "react";
import { isValidOrgSlug } from "@executor-js/api";
import {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  getExecutorServerAuthorizationHeader as getAuthorizationHeaderForConnection,
  normalizeExecutorServerConnection,
  originFromApiBaseUrl,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/sdk/shared";

export {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  apiBaseUrlForServerOrigin,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
} from "@executor-js/sdk/shared";

interface ExecutorWindowBridge {
  readonly serverConnection?: ExecutorServerConnectionInput;
  readonly getServerConnection?: () => Promise<ExecutorServerConnectionInput | null>;
  /**
   * The desktop bearer token, fetched on demand for the "Connect an agent"
   * install command (an external agent needs it in plaintext). The renderer's
   * own requests don't use it — the desktop main process injects the header at
   * the session layer.
   */
  readonly getServerAuthToken?: () => Promise<string | null>;
  readonly getServerProfiles?: () => Promise<string | null>;
  readonly setServerProfiles?: (value: string) => Promise<void>;
}

declare global {
  interface Window {
    readonly executor?: ExecutorWindowBridge;
  }
}

export const resolveBrowserExecutorServerConnection = (input: {
  readonly locationOrigin?: string;
  readonly bridge?: ExecutorWindowBridge;
}): ExecutorServerConnection => {
  const configured = input.bridge?.serverConnection;
  if (configured) {
    return normalizeExecutorServerConnection(configured);
  }

  return normalizeExecutorServerConnection({
    kind: "http",
    origin: input.locationOrigin ?? DEFAULT_EXECUTOR_SERVER_ORIGIN,
  });
};

const resolveInitialExecutorServerConnection = (): ExecutorServerConnection => {
  const browserWindow = globalThis.window;
  if (!browserWindow) {
    return normalizeExecutorServerConnection();
  }

  return resolveBrowserExecutorServerConnection({
    locationOrigin: browserWindow.location?.origin,
    bridge: browserWindow.executor,
  });
};

let activeConnection = resolveInitialExecutorServerConnection();

// ---------------------------------------------------------------------------
// Active org selector — the org the console URL is scoped to.
// ---------------------------------------------------------------------------
//
// Org-scoped hosts (cloud) send this on every API request so the server scopes
// to the URL's org, not the session's stored one — which is what lets two
// browser tabs sit in two different orgs at once (each tab's window.location is
// its own).
//
// Read straight from `window.location` at REQUEST time, not from a
// React-synced mirror: the API clients' `transformClient` runs only in the
// browser, so this never touches SSR/hydration, and it's always exactly the
// current URL with no effect-timing to get wrong. The org is the first path
// segment when it's a valid slug; reserved console roots (`/policies`,
// `/login`, …) are NOT valid slugs, so a bare path sends no header and the
// server falls back to the session org. Hosts without slugs (self-host,
// cloudflare) never produce one either.
export const EXECUTOR_ORG_HEADER = "x-executor-organization";

export const getActiveOrgSlug = (): string | null => {
  const pathname = globalThis.window?.location?.pathname;
  if (!pathname) return null;
  const first = pathname.split("/")[1];
  return first && isValidOrgSlug(first) ? first : null;
};

export const getExecutorOrganizationHeaders = (): Readonly<Record<string, string>> => {
  const orgSlug = getActiveOrgSlug();
  return orgSlug ? { [EXECUTOR_ORG_HEADER]: orgSlug } : {};
};

export const getExecutorServerConnection = (): ExecutorServerConnection => activeConnection;

export const setExecutorServerConnection = (input: ExecutorServerConnectionInput): void => {
  activeConnection = normalizeExecutorServerConnection(input);
};

export const setExecutorServerApiBaseUrl = (apiBaseUrl: string): void => {
  activeConnection = normalizeExecutorServerConnection({
    ...activeConnection,
    apiBaseUrl,
    origin: originFromApiBaseUrl(apiBaseUrl),
  });
};

export const getExecutorApiBaseUrl = (): string => activeConnection.apiBaseUrl;

export const getExecutorServerAuthPassword = (): string | null =>
  activeConnection.auth?.kind === "basic" ? activeConnection.auth.password : null;

export const getExecutorServerAuthorizationHeader = (
  connection: ExecutorServerConnection = activeConnection,
): string | null => getAuthorizationHeaderForConnection(connection);

interface ExecutorServerConnectionContextValue {
  readonly connection: ExecutorServerConnection;
  readonly setConnection: (input: ExecutorServerConnectionInput) => void;
}

const ExecutorServerConnectionContext =
  React.createContext<ExecutorServerConnectionContextValue | null>(null);

const hasDesktopServerConnectionBridge = (): boolean =>
  typeof globalThis.window?.executor?.getServerConnection === "function";

export function ExecutorServerConnectionProvider(
  props: React.PropsWithChildren<{
    readonly connection?: ExecutorServerConnectionInput;
  }>,
) {
  const initialConnection = React.useMemo(
    () =>
      props.connection
        ? normalizeExecutorServerConnection(props.connection)
        : getExecutorServerConnection(),
    [props.connection],
  );
  const [connection, setConnection] = React.useState(initialConnection);
  const setActiveConnection = React.useCallback((input: ExecutorServerConnectionInput): void => {
    const next = normalizeExecutorServerConnection(input);
    if (hasDesktopServerConnectionBridge() && next.kind !== "desktop-sidecar") return;
    activeConnection = next;
    setConnection(next);
  }, []);

  React.useEffect(() => {
    const next = props.connection
      ? normalizeExecutorServerConnection(props.connection)
      : getExecutorServerConnection();
    activeConnection = next;
    setConnection(next);
  }, [props.connection]);

  React.useEffect(() => {
    const bridge = globalThis.window?.executor;
    if (props.connection || !bridge) return;
    if (typeof bridge?.getServerConnection !== "function") return;

    let cancelled = false;
    void bridge.getServerConnection().then(
      (input) => {
        if (cancelled || !input) return;
        const next = normalizeExecutorServerConnection(input);
        setConnection(() => {
          // Electron loads the UI from a local URL before the async bridge
          // answers. Once it does, the bridge is the authoritative app server.
          activeConnection = next;
          return next;
        });
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
    };
  }, [props.connection]);

  activeConnection = connection;
  const value = React.useMemo(
    () => ({
      connection,
      setConnection: setActiveConnection,
    }),
    [connection, setActiveConnection],
  );

  return (
    <ExecutorServerConnectionContext.Provider value={value}>
      {props.children}
    </ExecutorServerConnectionContext.Provider>
  );
}

export function useExecutorServerConnection(): ExecutorServerConnection {
  return (
    React.useContext(ExecutorServerConnectionContext)?.connection ?? getExecutorServerConnection()
  );
}

export function useSetExecutorServerConnection(): (input: ExecutorServerConnectionInput) => void {
  return (
    React.useContext(ExecutorServerConnectionContext)?.setConnection ?? setExecutorServerConnection
  );
}

export function useExecutorServerConnectionControls(): ExecutorServerConnectionContextValue {
  const value = React.useContext(ExecutorServerConnectionContext);
  return (
    value ?? {
      connection: getExecutorServerConnection(),
      setConnection: setExecutorServerConnection,
    }
  );
}
