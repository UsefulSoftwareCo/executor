import { Data, Effect, Option, Schema } from "effect";

export const DEFAULT_EXECUTOR_SERVER_ORIGIN = "http://127.0.0.1:4000";
export const DEFAULT_EXECUTOR_SERVER_USERNAME = "executor";
export const EXECUTOR_ORG_SELECTOR_HEADER = "x-executor-organization";

export type ExecutorServerConnectionKind = "http" | "desktop-sidecar";
export type ExecutorLocalServerKind = "cli-daemon" | "desktop-sidecar" | "foreground";
export type ExecutorServerHeaderValue = {
  readonly kind: "env";
  readonly name: string;
};
export type ExecutorServerHeaders = Readonly<Record<string, ExecutorServerHeaderValue>>;

export class ExecutorServerHeaderResolutionError extends Data.TaggedError(
  "ExecutorServerHeaderResolutionError",
)<{
  readonly headerName: string;
  readonly envName: string;
}> {
  override get message(): string {
    return `Server profile header "${this.headerName}" references unset environment variable "${this.envName}".`;
  }
}

export type ExecutorServerAuth =
  | {
      readonly kind: "basic";
      readonly username?: string;
      readonly password: string;
    }
  | {
      readonly kind: "bearer";
      readonly token: string;
    }
  | {
      // OAuth 2.0 device-flow credential from `executor login` against a hosted
      // server. The access token is sent as a Bearer; `refreshToken` +
      // `expiresAt` (epoch seconds) + `tokenEndpoint` + `clientId` let the CLI
      // refresh it before expiry without a fresh browser login.
      readonly kind: "oauth";
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresAt?: number;
      readonly tokenEndpoint?: string;
      readonly clientId?: string;
    };

export interface ExecutorServerConnection {
  readonly kind: ExecutorServerConnectionKind;
  readonly key: string;
  readonly origin: string;
  readonly apiBaseUrl: string;
  readonly displayName: string;
  readonly auth?: ExecutorServerAuth;
  readonly headers?: ExecutorServerHeaders;
}

export interface ExecutorServerConnectionInput {
  readonly kind?: ExecutorServerConnectionKind;
  readonly key?: string;
  readonly origin?: string;
  readonly apiBaseUrl?: string;
  readonly displayName?: string;
  readonly auth?: ExecutorServerAuth;
  readonly headers?: ExecutorServerHeaders;
}

export interface ExecutorLocalServerManifest {
  readonly version: 1;
  readonly kind: ExecutorLocalServerKind;
  readonly pid: number;
  readonly startedAt: string;
  readonly dataDir: string;
  readonly scopeDir: string | null;
  readonly connection: ExecutorServerConnection;
  readonly owner: {
    readonly client: "cli" | "desktop";
    readonly version: string | null;
    readonly executablePath: string | null;
  };
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const displayNameFromOrigin = (origin: string): string =>
  origin.replace(/^https?:\/\//, "").replace(/\/+$/, "");

const normalizeExecutorServerHeaders = (
  headers: ExecutorServerHeaders | undefined,
): ExecutorServerHeaders | undefined => {
  if (!headers) return undefined;
  const entries = Object.entries(headers).flatMap(([rawHeaderName, value]) => {
    const headerName = rawHeaderName.trim();
    const envName = value.name.trim();
    if (!headerName || !envName) return [];
    return [[headerName, { kind: "env" as const, name: envName }] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const normalizeExecutorServerOrigin = (raw: string): string => {
  const trimmed = stripTrailingSlash(raw.trim());
  if (!trimmed) return DEFAULT_EXECUTOR_SERVER_ORIGIN;

  const parsed = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.pathname === "/api") {
    parsed.pathname = "/";
  }
  parsed.search = "";
  parsed.hash = "";
  return stripTrailingSlash(parsed.toString());
};

export const apiBaseUrlForServerOrigin = (origin: string): string => `${origin}/api`;

export const originFromApiBaseUrl = (raw: string): string => {
  const parsed = new URL(raw);
  if (parsed.pathname.endsWith("/api")) {
    parsed.pathname = parsed.pathname.slice(0, -"/api".length) || "/";
  }
  parsed.search = "";
  parsed.hash = "";
  return normalizeExecutorServerOrigin(parsed.toString());
};

export const normalizeExecutorServerConnection = (
  input: ExecutorServerConnectionInput = {},
): ExecutorServerConnection => {
  const origin = normalizeExecutorServerOrigin(
    input.origin ??
      (input.apiBaseUrl ? originFromApiBaseUrl(input.apiBaseUrl) : DEFAULT_EXECUTOR_SERVER_ORIGIN),
  );
  const apiBaseUrl = stripTrailingSlash(input.apiBaseUrl ?? apiBaseUrlForServerOrigin(origin));
  const kind = input.kind ?? "http";
  const headers = normalizeExecutorServerHeaders(input.headers);

  return {
    kind,
    key: input.key ?? `${kind}:${origin}`,
    origin,
    apiBaseUrl,
    displayName: input.displayName ?? displayNameFromOrigin(origin),
    ...(input.auth ? { auth: input.auth } : {}),
    ...(headers ? { headers } : {}),
  };
};

const encodeBasicCredentials = (credentials: string): string | null => {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(credentials);
  }

  const buffer = (
    globalThis as {
      readonly Buffer?: {
        readonly from: (value: string) => { readonly toString: (encoding: "base64") => string };
      };
    }
  ).Buffer;
  if (buffer) {
    return buffer.from(credentials).toString("base64");
  }

  return null;
};

export const getExecutorServerAuthorizationHeader = (
  connection: ExecutorServerConnection,
): string | null => {
  const auth = connection.auth;
  if (!auth) return null;
  if (auth.kind === "bearer") return `Bearer ${auth.token}`;
  if (auth.kind === "oauth") return `Bearer ${auth.accessToken}`;
  const encoded = encodeBasicCredentials(
    `${auth.username ?? DEFAULT_EXECUTOR_SERVER_USERNAME}:${auth.password}`,
  );
  return encoded ? `Basic ${encoded}` : null;
};

export const resolveExecutorServerConfiguredHeaders = (
  connection: ExecutorServerConnection,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Record<string, string>, ExecutorServerHeaderResolutionError> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [headerName, value] of Object.entries(connection.headers ?? {})) {
      if (value.kind !== "env") continue;
      const headerValue = env[value.name];
      if (headerValue === undefined || headerValue.length === 0) {
        return yield* new ExecutorServerHeaderResolutionError({ headerName, envName: value.name });
      }
      resolved[headerName] = headerValue;
    }
    return resolved;
  });

export const resolveExecutorServerRequestHeaders = (
  connection: ExecutorServerConnection,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Record<string, string>, ExecutorServerHeaderResolutionError> =>
  resolveExecutorServerConfiguredHeaders(connection, env).pipe(
    Effect.map((headers) => {
      const authorization = getExecutorServerAuthorizationHeader(connection);
      if (!authorization) return headers;
      return { ...headers, authorization };
    }),
  );

const ExecutorServerAuthJson = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("basic"),
    username: Schema.optional(Schema.String),
    password: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    token: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
    tokenEndpoint: Schema.optional(Schema.String),
    clientId: Schema.optional(Schema.String),
  }),
]);

const ExecutorServerHeaderJson = Schema.Struct({
  kind: Schema.Literal("env"),
  name: Schema.String,
});

const ExecutorServerConnectionJson = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["http", "desktop-sidecar"])),
  key: Schema.optional(Schema.String),
  origin: Schema.String,
  apiBaseUrl: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  auth: Schema.optional(ExecutorServerAuthJson),
  headers: Schema.optional(Schema.Record(Schema.String, ExecutorServerHeaderJson)),
});

const ExecutorLocalServerManifestJson = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["cli-daemon", "desktop-sidecar", "foreground"]),
  pid: Schema.Number,
  startedAt: Schema.String,
  dataDir: Schema.String,
  scopeDir: Schema.NullOr(Schema.String),
  connection: ExecutorServerConnectionJson,
  owner: Schema.Struct({
    client: Schema.Literals(["cli", "desktop"]),
    version: Schema.NullOr(Schema.String),
    executablePath: Schema.NullOr(Schema.String),
  }),
});

const decodeUnknownJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const decodeExecutorLocalServerManifestJson = Schema.decodeUnknownOption(
  ExecutorLocalServerManifestJson,
);

const canNormalizeServerOrigin = (origin: string): boolean => {
  const trimmed = stripTrailingSlash(origin.trim());
  if (!trimmed) return true;
  return URL.canParse(/^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`);
};

export const parseExecutorLocalServerManifest = (
  raw: string,
): ExecutorLocalServerManifest | null => {
  const json = decodeUnknownJsonOption(raw);
  if (Option.isNone(json)) return null;
  const decoded = decodeExecutorLocalServerManifestJson(json.value);
  if (Option.isNone(decoded)) return null;
  const parsed = decoded.value;
  if (
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    !canNormalizeServerOrigin(parsed.connection.origin)
  ) {
    return null;
  }

  const connection = normalizeExecutorServerConnection(parsed.connection);
  return {
    version: 1,
    kind: parsed.kind,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    dataDir: parsed.dataDir,
    scopeDir: parsed.scopeDir,
    connection,
    owner: {
      client: parsed.owner.client,
      version: parsed.owner.version,
      executablePath: parsed.owner.executablePath,
    },
  };
};

export const serializeExecutorLocalServerManifest = (
  manifest: ExecutorLocalServerManifest,
): string => `${JSON.stringify(manifest, null, 2)}\n`;
