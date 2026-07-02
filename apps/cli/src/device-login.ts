// ---------------------------------------------------------------------------
// CLI device-login (OAuth 2.0 Device Authorization Grant, RFC 8628).
//
// `executor login` against a hosted server:
//   1. discover the provider device endpoints + public client id from the
//      server (`GET /api/auth/cli-login`),
//   2. request a device code, show the user_code + open the verification URL,
//   3. poll the token endpoint until the user approves in the browser,
//   4. hand the access + refresh tokens back to be stored in the profile.
//
// The flow is provider-neutral: the server advertises WorkOS (cloud) or Better
// Auth (self-host) endpoints, and both speak the same RFC 8628 wire shape, so
// this module never branches on provider. Tokens are sent to the `/api/*`
// plane as `Authorization: Bearer <access_token>`.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";

export interface CliLoginDiscovery {
  readonly provider: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope?: string;
  /**
   * How to encode the device-authorization + token requests. RFC 8628 mandates
   * `form` (WorkOS), but some providers' endpoints only accept JSON (Better
   * Auth). The server tells us via discovery; defaults to `form`.
   */
  readonly requestFormat: "form" | "json";
}

export interface DeviceCodeGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface DeviceTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch seconds the access token expires, when known. */
  readonly expiresAt?: number;
  /** The signed-in account's email, if the token response carries a user. */
  readonly email?: string;
  /** The bound organization id, from the response or the token's org_id claim. */
  readonly organizationId?: string;
}

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_SECONDS = 5;

export class DeviceLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceLoginError";
  }
}

const cliLoginUrl = (origin: string): string => `${origin.replace(/\/+$/, "")}/api/auth/cli-login`;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Pull `user.email` out of a token response (WorkOS returns the user inline). */
const readUserEmail = (body: Record<string, unknown>): string | undefined => {
  const user = body.user;
  if (user && typeof user === "object" && "email" in user) {
    return asString((user as { email?: unknown }).email);
  }
  return undefined;
};

/**
 * Decode a JWT access token's claims WITHOUT verifying it. The CLI only uses
 * this for display (`whoami`, the post-login summary) and to read `exp`, the
 * server is the only thing that verifies the token's signature.
 */
export const decodeAccessTokenClaims = (
  accessToken: string,
): Record<string, unknown> | undefined => {
  const segments = accessToken.split(".");
  if (segments.length !== 3) return undefined;
  const payloadSegment = segments[1];
  if (!payloadSegment) return undefined;
  try {
    const json = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Read `exp` (epoch seconds) out of a JWT access token without verifying it. */
export const accessTokenExpiry = (accessToken: string): number | undefined =>
  asNumber(decodeAccessTokenClaims(accessToken)?.exp);

const deriveExpiresAt = (tokens: {
  accessToken: string;
  expiresIn?: number;
}): number | undefined => {
  if (tokens.expiresIn !== undefined) {
    return Math.floor(Date.now() / 1000) + tokens.expiresIn;
  }
  return accessTokenExpiry(tokens.accessToken);
};

const formBody = (fields: Record<string, string | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
};

const definedFields = (fields: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;

const post = async (
  url: string,
  fields: Record<string, string | undefined>,
  format: "form" | "json",
) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": format === "json" ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: format === "json" ? JSON.stringify(definedFields(fields)) : formBody(fields),
  });

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "invalid_response", error_description: text.slice(0, 200) };
  }
};

export const discoverCliLogin = async (origin: string): Promise<CliLoginDiscovery> => {
  let response: Response;
  try {
    response = await fetch(cliLoginUrl(origin), { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new DeviceLoginError(
      `Could not reach ${origin} to start login: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new DeviceLoginError(
      `${origin} does not support CLI login (GET /api/auth/cli-login returned ${response.status}). ` +
        "It may be an older server, or a local/unauthenticated server that needs no login.",
    );
  }
  const body = await readJson(response);
  const deviceAuthorizationEndpoint = asString(body.deviceAuthorizationEndpoint);
  const tokenEndpoint = asString(body.tokenEndpoint);
  const clientId = asString(body.clientId);
  if (!deviceAuthorizationEndpoint || !tokenEndpoint || !clientId) {
    throw new DeviceLoginError(`${origin} returned an incomplete CLI-login configuration.`);
  }
  return {
    provider: asString(body.provider) ?? "unknown",
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    clientId,
    scope: asString(body.scope),
    requestFormat: asString(body.requestFormat) === "json" ? "json" : "form",
  };
};

export const requestDeviceCode = async (discovery: CliLoginDiscovery): Promise<DeviceCodeGrant> => {
  const response = await post(
    discovery.deviceAuthorizationEndpoint,
    { client_id: discovery.clientId, scope: discovery.scope },
    discovery.requestFormat,
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new DeviceLoginError(
      `Device authorization failed (${response.status}): ${asString(body.error_description) ?? asString(body.error) ?? "unknown error"}`,
    );
  }
  const deviceCode = asString(body.device_code);
  const userCode = asString(body.user_code);
  const verificationUri = asString(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new DeviceLoginError("Device authorization response was missing required fields.");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: asString(body.verification_uri_complete),
    expiresInSeconds: asNumber(body.expires_in) ?? 300,
    intervalSeconds: asNumber(body.interval) ?? DEFAULT_INTERVAL_SECONDS,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the token endpoint until the user approves, honoring the RFC 8628
 * pacing rules (`authorization_pending` keeps waiting, `slow_down` backs off,
 * `access_denied` / `expired_token` are terminal).
 */
export const pollForDeviceTokens = async (
  discovery: CliLoginDiscovery,
  grant: DeviceCodeGrant,
  options: { readonly now?: () => number } = {},
): Promise<DeviceTokens> => {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + grant.expiresInSeconds * 1000;
  let intervalMs = Math.max(1, grant.intervalSeconds) * 1000;

  for (;;) {
    if (now() >= deadline) {
      throw new DeviceLoginError("Login timed out before it was approved.");
    }
    await sleep(intervalMs);

    const response = await post(
      discovery.tokenEndpoint,
      {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: grant.deviceCode,
        client_id: discovery.clientId,
      },
      discovery.requestFormat,
    );
    const body = await readJson(response);

    if (response.ok) {
      const accessToken = asString(body.access_token);
      if (!accessToken) {
        throw new DeviceLoginError("Token response was missing an access token.");
      }
      const claims = decodeAccessTokenClaims(accessToken);
      return {
        accessToken,
        refreshToken: asString(body.refresh_token),
        expiresAt: deriveExpiresAt({ accessToken, expiresIn: asNumber(body.expires_in) }),
        email:
          readUserEmail(body) ?? (typeof claims?.email === "string" ? claims.email : undefined),
        organizationId:
          asString(body.organization_id) ??
          (typeof claims?.org_id === "string" ? claims.org_id : undefined),
      };
    }

    const error = asString(body.error);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (error === "access_denied") {
      throw new DeviceLoginError("Login was denied.");
    }
    if (error === "expired_token") {
      throw new DeviceLoginError("The login request expired before it was approved.");
    }
    throw new DeviceLoginError(
      `Login failed: ${asString(body.error_description) ?? error ?? `HTTP ${response.status}`}`,
    );
  }
};

/** Exchange a refresh token for a fresh access token (silent re-auth). Only
 * providers that issue refresh tokens reach here (WorkOS, which is form-encoded
 * per RFC 8628); Better Auth's device flow issues no refresh token. */
export const refreshDeviceTokens = async (input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshToken: string;
}): Promise<DeviceTokens> => {
  const response = await post(
    input.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    },
    "form",
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new DeviceLoginError(
      `Token refresh failed: ${asString(body.error_description) ?? asString(body.error) ?? `HTTP ${response.status}`}`,
    );
  }
  const accessToken = asString(body.access_token);
  if (!accessToken) throw new DeviceLoginError("Refresh response was missing an access token.");
  return {
    accessToken,
    refreshToken: asString(body.refresh_token) ?? input.refreshToken,
    expiresAt: deriveExpiresAt({ accessToken, expiresIn: asNumber(body.expires_in) }),
  };
};

export type BrowserOpenCommand = readonly [command: string, args: ReadonlyArray<string>];

const normalizeBrowserOpenUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

export const browserOpenCommand = (
  url: string,
  platform: typeof process.platform = process.platform,
): BrowserOpenCommand | undefined => {
  const normalizedUrl = normalizeBrowserOpenUrl(url);
  if (!normalizedUrl) return undefined;
  if (platform === "darwin") return ["open", [normalizedUrl]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", normalizedUrl]];
  return ["xdg-open", [normalizedUrl]];
};

/** Best-effort open the verification URL in the user's default browser. */
export const openBrowser = (url: string): void => {
  const openCommand = browserOpenCommand(url);
  if (!openCommand) return;
  const [command, args] = openCommand;
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // Swallow async spawn failures (e.g. the opener binary is missing), the
    // URL is printed too, so the user can open it by hand.
    (child as { on?: (event: "error", listener: () => void) => void }).on?.("error", () => {});
    child.unref();
  } catch {
    // Ignore, the URL is also printed for manual opening.
  }
};
