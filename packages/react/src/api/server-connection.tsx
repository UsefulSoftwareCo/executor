import * as React from "react";
import {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  getExecutorServerAuthorizationHeader as getAuthorizationHeaderForConnection,
  normalizeExecutorServerConnection,
  originFromApiBaseUrl,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/sdk/shared";

export {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  DEFAULT_EXECUTOR_SERVER_USERNAME,
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
  readonly getServerProfiles?: () => Promise<string | null>;
  readonly setServerProfiles?: (value: string) => Promise<void>;
  readonly baseUrl?: string;
  readonly authPassword?: string;
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

  const legacyBaseUrl = input.bridge?.baseUrl;
  if (legacyBaseUrl) {
    return normalizeExecutorServerConnection({
      kind: "desktop-sidecar",
      origin: legacyBaseUrl,
      displayName: "Desktop sidecar",
      ...(input.bridge?.authPassword
        ? {
            auth: {
              kind: "basic",
              username: DEFAULT_EXECUTOR_SERVER_USERNAME,
              password: input.bridge.authPassword,
            },
          }
        : {}),
    });
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
    const initialKey = activeConnection.key;
    void bridge.getServerConnection().then(
      (input) => {
        if (cancelled || !input) return;
        const next = normalizeExecutorServerConnection(input);
        setConnection((current) => {
          if (current.key !== initialKey) return current;
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
