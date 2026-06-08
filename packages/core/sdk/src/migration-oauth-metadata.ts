/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: v1 migration resolves archived OAuth metadata before committing migrated rows */

import { Schema } from "effect";

import type { MigrationPlan } from "./migration-spec";

const OAuthAuthorizationServerMetadata = Schema.Struct({
  authorization_endpoint: Schema.String,
});
const decodeOAuthAuthorizationServerMetadata = Schema.decodeUnknownSync(
  OAuthAuthorizationServerMetadata,
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

const fetchOAuthAuthorizationEndpoint = async (
  metadataUrl: string,
  fetchImpl: MigrationOAuthMetadataFetch,
  timeoutMs: number,
): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(metadataUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `OAuth authorization-server metadata ${metadataUrl} returned HTTP ${response.status}`,
      );
    }
    const metadata = decodeOAuthAuthorizationServerMetadata(await response.json());
    return validateMigrationOAuthUrl(metadata.authorization_endpoint, "authorization_endpoint");
  } finally {
    clearTimeout(timeout);
  }
};

export const resolveMigrationOAuthAuthorizationUrls = async (
  plan: MigrationPlan,
  options: ResolveMigrationOAuthAuthorizationUrlsOptions = {},
): Promise<ReadonlyMap<string, string>> => {
  const clientsWithMetadata = plan.oauthClients.filter((client) =>
    client.authorizationServerMetadataUrl?.trim(),
  );
  if (clientsWithMetadata.length === 0) return new Map();

  const fetchImpl = options.fetch;
  if (!fetchImpl) {
    throw new Error("OAuth metadata resolution requires an injected fetch implementation.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_METADATA_TIMEOUT_MS;
  const endpointByMetadataUrl = new Map<string, Promise<string>>();
  const resolved = new Map<string, string>();

  for (const client of clientsWithMetadata) {
    const metadataUrl = validateMigrationOAuthUrl(
      client.authorizationServerMetadataUrl ?? "",
      "authorizationServerMetadataUrl",
    );
    let endpoint = endpointByMetadataUrl.get(metadataUrl);
    if (!endpoint) {
      endpoint = fetchOAuthAuthorizationEndpoint(metadataUrl, fetchImpl, timeoutMs);
      endpointByMetadataUrl.set(metadataUrl, endpoint);
    }
    resolved.set(migrationOAuthClientPlanKey(client), await endpoint);
  }

  return resolved;
};

export const migrationOAuthAuthorizationUrlFor = (
  client: MigrationPlan["oauthClients"][number],
  resolvedUrls: ReadonlyMap<string, string>,
): string => resolvedUrls.get(migrationOAuthClientPlanKey(client)) ?? client.authorizationUrl;
