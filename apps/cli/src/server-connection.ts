import {
  normalizeExecutorServerConnection,
  type ExecutorLocalServerManifest,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
} from "@executor-js/sdk/shared";
import { canAutoStartLocalDaemonForHost } from "./daemon";

// Bearer is the only credential the CLI derives from the environment: a hosted
// API key (`EXECUTOR_API_KEY`) or a local/desktop server's bearer token
// (`EXECUTOR_AUTH_TOKEN`). Local servers publish their token in the manifest, so
// the env override is mainly for pointing the CLI at a remote instance.
export const readCliServerAuth = (
  env: Record<string, string | undefined> = process.env,
): ExecutorServerAuth | undefined => {
  const token = env.EXECUTOR_API_KEY ?? env.EXECUTOR_AUTH_TOKEN;
  return token ? { kind: "bearer", token } : undefined;
};

export const parseCliExecutorServerConnection = (
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): ExecutorServerConnection => {
  const connection = normalizeExecutorServerConnection({
    origin: baseUrl,
  });
  return normalizeExecutorServerConnection({
    ...connection,
    auth: readCliServerAuth(env),
  });
};

export const withCliServerAuthFallback = (
  connection: ExecutorServerConnection,
  env: Record<string, string | undefined> = process.env,
): ExecutorServerConnection =>
  connection.auth
    ? connection
    : normalizeExecutorServerConnection({
        ...connection,
        auth: readCliServerAuth(env),
      });

export const canAutoStartCliServerConnection = (connection: ExecutorServerConnection): boolean => {
  if (connection.kind !== "http") return false;
  // A stored credential (basic password, bearer key, or an oauth device-login
  // token) means the user is targeting an EXISTING authenticated server, never
  // spawn a local daemon for it, even when it happens to be on http://localhost
  // (e.g. a hosted server reached over a tunnel, or a local e2e cloud server).
  if (connection.auth) return false;
  const url = new URL(connection.origin);
  return url.protocol === "http:" && canAutoStartLocalDaemonForHost(url.hostname);
};

export type CliServerConnectionSource =
  | "explicit"
  | "default-profile"
  | "implicit-default"
  | "active-local";

export type ActiveLocalServerDecision =
  | { readonly kind: "use-requested"; readonly connection: ExecutorServerConnection }
  | { readonly kind: "use-active"; readonly connection: ExecutorServerConnection }
  | { readonly kind: "conflict"; readonly active: ExecutorLocalServerManifest };

const sameOrigin = (left: string, right: string): boolean =>
  normalizeExecutorServerConnection({ origin: left }).origin ===
  normalizeExecutorServerConnection({ origin: right }).origin;

export const chooseCliServerConnectionWithActiveLocal = (input: {
  readonly requested: ExecutorServerConnection;
  readonly source: CliServerConnectionSource;
  readonly active: ExecutorLocalServerManifest | null;
}): ActiveLocalServerDecision => {
  if (!input.active) return { kind: "use-requested", connection: input.requested };
  if (input.source === "active-local") {
    return { kind: "use-active", connection: input.active.connection };
  }
  if (sameOrigin(input.requested.origin, input.active.connection.origin)) {
    return { kind: "use-active", connection: input.active.connection };
  }
  if (canAutoStartCliServerConnection(input.requested)) {
    return { kind: "conflict", active: input.active };
  }
  return { kind: "use-requested", connection: input.requested };
};
