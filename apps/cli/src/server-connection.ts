import {
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  normalizeExecutorServerConnection,
  type ExecutorLocalServerManifest,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
} from "@executor-js/sdk/shared";
import { canAutoStartLocalDaemonForHost } from "./daemon";

const readCliBasicServerAuth = (
  env: Record<string, string | undefined> = process.env,
): ExecutorServerAuth | undefined => {
  const password = env.EXECUTOR_AUTH_PASSWORD;
  if (!password) return undefined;
  return {
    kind: "basic",
    username: env.EXECUTOR_AUTH_USERNAME ?? DEFAULT_EXECUTOR_SERVER_USERNAME,
    password,
  };
};

const readCliBearerServerAuth = (
  env: Record<string, string | undefined> = process.env,
): ExecutorServerAuth | undefined => {
  const token = env.EXECUTOR_API_KEY ?? env.EXECUTOR_AUTH_TOKEN;
  if (!token) return undefined;
  return { kind: "bearer", token };
};

export const readCliServerAuth = (
  env: Record<string, string | undefined> = process.env,
): ExecutorServerAuth | undefined => readCliBearerServerAuth(env) ?? readCliBasicServerAuth(env);

const readCliServerAuthForConnection = (
  connection: ExecutorServerConnection,
  env: Record<string, string | undefined> = process.env,
): ExecutorServerAuth | undefined => {
  const bearer = readCliBearerServerAuth(env);
  const basic = readCliBasicServerAuth(env);
  const protocol = new URL(connection.origin).protocol;

  if (protocol === "https:") {
    return bearer ?? basic;
  }

  return basic ?? bearer;
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
    auth: readCliServerAuthForConnection(connection, env),
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
        auth: readCliServerAuthForConnection(connection, env),
      });

export const canAutoStartCliServerConnection = (connection: ExecutorServerConnection): boolean => {
  if (connection.kind !== "http") return false;
  if (connection.auth?.kind === "basic") return false;
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
