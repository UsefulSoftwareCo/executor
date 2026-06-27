import { randomUUID } from "node:crypto";

export const E2E_CLOUDFLARE_ACCESS_AUDIENCE = "executor-e2e-cloudflare-access";

export type CloudflareAccessTokenRequest =
  | {
      readonly kind: "human";
      readonly subject: string;
      readonly email: string;
      readonly name?: string;
      readonly groups?: ReadonlyArray<string>;
      readonly audience?: string;
      readonly expiresInSeconds?: number;
    }
  | {
      readonly kind: "service";
      readonly commonName: string;
      readonly audience?: string;
      readonly expiresInSeconds?: number;
    };

export interface CloudflareAccessLedgerEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly operation: string;
  readonly tokenKind?: "human" | "service";
}

export interface CloudflareAccessHealth {
  readonly ok: true;
  readonly bootNonce: string;
}

const isTokenResponse = (value: unknown): value is { readonly token: string } =>
  typeof value === "object" &&
  value !== null &&
  "token" in value &&
  typeof value.token === "string";

const isHealthResponse = (value: unknown): value is CloudflareAccessHealth =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  value.ok === true &&
  "bootNonce" in value &&
  typeof value.bootNonce === "string" &&
  value.bootNonce.length > 0;

const isLedgerEntry = (value: unknown): value is CloudflareAccessLedgerEntry =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "number" &&
  "timestamp" in value &&
  typeof value.timestamp === "string" &&
  "method" in value &&
  typeof value.method === "string" &&
  "path" in value &&
  typeof value.path === "string" &&
  "status" in value &&
  typeof value.status === "number" &&
  "operation" in value &&
  typeof value.operation === "string" &&
  (!("tokenKind" in value) || value.tokenKind === "human" || value.tokenKind === "service");

const isLedgerResponse = (
  value: unknown,
): value is { readonly entries: ReadonlyArray<CloudflareAccessLedgerEntry> } =>
  typeof value === "object" &&
  value !== null &&
  "entries" in value &&
  Array.isArray(value.entries) &&
  value.entries.every(isLedgerEntry);

export const issueCloudflareAccessToken = async (
  baseUrl: string,
  request: CloudflareAccessTokenRequest,
) => {
  const response = await fetch(new URL("/_e2e/issue", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(
      `Cloudflare Access emulator refused token issue (${response.status}): ${await response.text()}`,
    );
  }
  const body: unknown = await response.json();
  if (!isTokenResponse(body)) {
    throw new Error("Cloudflare Access emulator returned no token");
  }
  return body.token;
};

export const accessAssertionHeaders = (token: string) => ({
  "Cf-Access-Jwt-Assertion": token,
});

export const readCloudflareAccessHealth = async (baseUrl: string) => {
  const response = await fetch(new URL("/health", baseUrl));
  if (!response.ok) {
    throw new Error(`Cloudflare Access emulator health failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!isHealthResponse(body)) {
    throw new Error("Cloudflare Access emulator returned malformed health identity");
  }
  return body;
};

export const readCloudflareAccessLedger = async (baseUrl: string) => {
  const response = await fetch(new URL("/_e2e/ledger", baseUrl));
  if (!response.ok) {
    throw new Error(`Cloudflare Access emulator ledger failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!isLedgerResponse(body)) {
    throw new Error("Cloudflare Access emulator returned a malformed ledger");
  }
  return body.entries;
};

/**
 * Prove the supplied attach dependency is the full test issuer, not merely an
 * arbitrary OIDC endpoint: it must identify its boot, mint a token, and record
 * that mint in its typed ledger.
 */
export const verifyCloudflareAccessEmulator = async (
  baseUrl: string,
  options: { readonly expectedBootNonce?: string } = {},
) => {
  const health = await readCloudflareAccessHealth(baseUrl);
  if (options.expectedBootNonce && health.bootNonce !== options.expectedBootNonce) {
    throw new Error(
      `Cloudflare Access emulator boot identity mismatch: expected ${options.expectedBootNonce}, received ${health.bootNonce}`,
    );
  }
  const before = await readCloudflareAccessLedger(baseUrl);
  const afterId = before.reduce((maximum, entry) => Math.max(maximum, entry.id), 0);
  const marker = randomUUID();
  const token = await issueCloudflareAccessToken(baseUrl, {
    kind: "human",
    subject: `e2e-emulator-check-${marker}`,
    email: "admin@e2e.test",
    name: "E2E emulator capability check",
  });
  const after = await readCloudflareAccessLedger(baseUrl);
  const recorded = after.some(
    (entry) =>
      entry.id > afterId &&
      entry.operation === "token.issue" &&
      entry.tokenKind === "human" &&
      entry.status === 200,
  );
  if (!recorded) {
    throw new Error("Cloudflare Access emulator did not record its capability-check token");
  }
  return { bootNonce: health.bootNonce, token };
};
