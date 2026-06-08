/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: v1 migration resolves archived OAuth metadata before committing migrated rows */

import { Schema } from "effect";

import type { MigrationPlan } from "./migration-spec";

const OAuthAuthorizationServerMetadata = Schema.Struct({
  authorization_endpoint: Schema.String,
});
const decodeOAuthAuthorizationServerMetadata = Schema.decodeUnknownSync(
  OAuthAuthorizationServerMetadata,
);
const OAuthProtectedResourceMetadata = Schema.Struct({
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
});
const decodeOAuthProtectedResourceMetadata = Schema.decodeUnknownSync(
  OAuthProtectedResourceMetadata,
);
const DEFAULT_OAUTH_METADATA_TIMEOUT_MS = 20_000;

export type MigrationOAuthMetadataFetch = (
  input: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}>;

export interface ResolveMigrationOAuthAuthorizationUrlsOptions {
  readonly fetch?: MigrationOAuthMetadataFetch;
  readonly timeoutMs?: number;
}

export const migrationOAuthClientPlanKey = (
  client: MigrationPlan["oauthClients"][number],
): string =>
  `${client.ownerKeys.tenant}\0${client.ownerKeys.owner}\0${client.ownerKeys.subject}\0${client.slug}`;

const validateMigrationOAuthUrl = (value: string, label: string): string => {
  const trimmed = value.trim();
  const url = new URL(trimmed);
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error(`${label} must use https: or loopback http: ${trimmed}`);
  }
  return trimmed;
};

const fetchOAuthJson = async (
  url: string,
  fetchImpl: MigrationOAuthMetadataFetch,
  timeoutMs: number,
): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OAuth metadata ${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const fetchOAuthAuthorizationEndpoint = async (
  metadataUrl: string,
  fetchImpl: MigrationOAuthMetadataFetch,
  timeoutMs: number,
): Promise<string> => {
  const metadata = decodeOAuthAuthorizationServerMetadata(
    await fetchOAuthJson(metadataUrl, fetchImpl, timeoutMs),
  );
  return validateMigrationOAuthUrl(metadata.authorization_endpoint, "authorization_endpoint");
};

const wellKnownAuthorizationServerUrlFor = (
  issuer: string,
  algorithm: "oauth2" | "oidc",
): string => {
  const url = new URL(validateMigrationOAuthUrl(issuer, "issuer"));
  const origin = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, "");
  const suffix = algorithm === "oauth2" ? "oauth-authorization-server" : "openid-configuration";
  return path && path !== "/"
    ? `${origin}/.well-known/${suffix}${path}`
    : `${origin}/.well-known/${suffix}`;
};

const resolveAuthorizationEndpointFromIssuer = async (
  issuer: string,
  fetchImpl: MigrationOAuthMetadataFetch,
  timeoutMs: number,
): Promise<string | null> => {
  for (const algorithm of ["oauth2", "oidc"] as const) {
    try {
      return await fetchOAuthAuthorizationEndpoint(
        wellKnownAuthorizationServerUrlFor(issuer, algorithm),
        fetchImpl,
        timeoutMs,
      );
    } catch {
      // Best-effort fallback discovery: try the next standards-defined location.
    }
  }
  return null;
};

const protectedResourceMetadataUrlsFor = (resource: string): readonly string[] => {
  const url = new URL(validateMigrationOAuthUrl(resource, "resource"));
  const origin = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path && path !== "/") {
    urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  }
  urls.push(`${origin}/.well-known/oauth-protected-resource`);
  return urls;
};

const discoverAuthorizationServersFromResource = async (
  resource: string,
  fetchImpl: MigrationOAuthMetadataFetch,
  timeoutMs: number,
): Promise<readonly string[]> => {
  for (const metadataUrl of protectedResourceMetadataUrlsFor(resource)) {
    try {
      const metadata = decodeOAuthProtectedResourceMetadata(
        await fetchOAuthJson(metadataUrl, fetchImpl, timeoutMs),
      );
      return metadata.authorization_servers ?? [];
    } catch {
      // Best-effort fallback discovery: try the next protected-resource location.
    }
  }
  return [];
};

const pushCandidate = (candidates: string[], value: string | null | undefined): void => {
  const trimmed = value?.trim();
  if (!trimmed || candidates.includes(trimmed)) return;
  candidates.push(trimmed);
};

const resolveMigrationOAuthAuthorizationUrl = async (
  client: MigrationPlan["oauthClients"][number],
  fetchImpl: MigrationOAuthMetadataFetch,
  timeoutMs: number,
): Promise<string | null> => {
  const metadataUrl = client.authorizationServerMetadataUrl?.trim();
  if (metadataUrl) {
    return await fetchOAuthAuthorizationEndpoint(
      validateMigrationOAuthUrl(metadataUrl, "authorizationServerMetadataUrl"),
      fetchImpl,
      timeoutMs,
    );
  }

  if (client.grant !== "authorization_code") return null;

  const candidates: string[] = [];
  if (client.resource?.trim()) {
    try {
      for (const issuer of await discoverAuthorizationServersFromResource(
        client.resource,
        fetchImpl,
        timeoutMs,
      )) {
        pushCandidate(candidates, issuer);
      }
    } catch {
      // Best-effort: fall through to the stored authorization URL candidate.
    }
  }
  pushCandidate(candidates, client.authorizationUrl);

  for (const candidate of candidates) {
    const endpoint = await resolveAuthorizationEndpointFromIssuer(candidate, fetchImpl, timeoutMs);
    if (endpoint) return endpoint;
  }
  return null;
};

export const migrationOAuthClientNeedsAuthorizationUrlResolution = (
  client: MigrationPlan["oauthClients"][number],
): boolean =>
  !!client.authorizationServerMetadataUrl?.trim() ||
  (client.grant === "authorization_code" &&
    (!!client.resource?.trim() || !!client.authorizationUrl.trim()));

export const migrationOAuthClientAuthorizationUrlResolutionSource = (
  client: MigrationPlan["oauthClients"][number],
): string =>
  client.authorizationServerMetadataUrl?.trim() ||
  client.resource?.trim() ||
  client.authorizationUrl.trim();

export const resolveMigrationOAuthAuthorizationUrls = async (
  plan: MigrationPlan,
  options: ResolveMigrationOAuthAuthorizationUrlsOptions = {},
): Promise<ReadonlyMap<string, string>> => {
  const clientsToResolve = plan.oauthClients.filter(
    migrationOAuthClientNeedsAuthorizationUrlResolution,
  );
  if (clientsToResolve.length === 0) return new Map();

  const fetchImpl = options.fetch;
  if (!fetchImpl) {
    throw new Error("OAuth metadata resolution requires an injected fetch implementation.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_METADATA_TIMEOUT_MS;
  const endpointByPlanKey = new Map<string, Promise<string | null>>();
  const resolved = new Map<string, string>();

  for (const client of clientsToResolve) {
    const key = migrationOAuthClientPlanKey(client);
    let endpoint = endpointByPlanKey.get(key);
    if (!endpoint) {
      endpoint = resolveMigrationOAuthAuthorizationUrl(client, fetchImpl, timeoutMs);
      endpointByPlanKey.set(key, endpoint);
    }
    const authorizationUrl = await endpoint;
    if (authorizationUrl) resolved.set(key, authorizationUrl);
  }

  return resolved;
};

export const migrationOAuthAuthorizationUrlFor = (
  client: MigrationPlan["oauthClients"][number],
  resolvedUrls: ReadonlyMap<string, string>,
): string => resolvedUrls.get(migrationOAuthClientPlanKey(client)) ?? client.authorizationUrl;
