import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  E2E_CLOUDFLARE_ACCESS_AUDIENCE,
  type CloudflareAccessLedgerEntry,
  type CloudflareAccessTokenRequest,
} from "../src/cloudflare-access-emulator";

// @executor-js/emulate has generic OIDC providers, including Okta, but none
// implements Cloudflare Access. Okta can issue human ID tokens and serve JWKS,
// but it cannot emit Access's application-token wire shape (`type: app`, array
// `aud`, empty service `sub`, and `common_name`) or the
// `/cdn-cgi/access/certs` endpoint. A single scoped issuer here proves both
// human and service assertions against the exact origin-facing contract.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_LEDGER_ENTRIES = 200;

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const port = Number(argument("--port"));
const audience = argument("--audience") ?? E2E_CLOUDFLARE_ACCESS_AUDIENCE;
const bootNonce = argument("--boot-nonce");
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error("cloudflare-access-emulator: --port must be a port in 1-65535");
  process.exit(2);
}
if (!bootNonce || !/^[a-zA-Z0-9-]{8,128}$/.test(bootNonce)) {
  console.error("cloudflare-access-emulator: --boot-nonce must identify this boot");
  process.exit(2);
}

const issuer = `http://127.0.0.1:${port}`;
const keyId = `executor-e2e-access-${bootNonce}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const exportedPublicKey = publicKey.export({ format: "jwk" });
const jwk = {
  kty: exportedPublicKey.kty,
  n: exportedPublicKey.n,
  e: exportedPublicKey.e,
  alg: "RS256",
  use: "sig",
  kid: keyId,
};

// This process is one ephemeral, loopback-only fixture. The ledger intentionally
// records only route metadata and token kind, never headers, claims, or JWTs.
const ledger: CloudflareAccessLedgerEntry[] = [];
let nextLedgerId = 1;

const record = (
  request: IncomingMessage,
  path: string,
  status: number,
  operation: string,
  tokenKind?: "human" | "service",
) => {
  ledger.push({
    id: nextLedgerId++,
    timestamp: new Date().toISOString(),
    method: request.method ?? "UNKNOWN",
    path,
    status,
    operation,
    ...(tokenKind ? { tokenKind } : {}),
  });
  if (ledger.length > MAX_LEDGER_ENTRIES) ledger.splice(0, ledger.length - MAX_LEDGER_ENTRIES);
};

const sendJson = (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  status: number,
  operation: string,
  body: unknown,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly tokenKind?: "human" | "service";
  } = {},
) => {
  record(request, path, status, operation, options.tokenKind);
  response.writeHead(status, {
    "content-type": "application/json",
    ...options.headers,
  });
  response.end(JSON.stringify(body));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

const optionalStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

const optionalExpiry = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= -3_600 && value <= 3_600
    ? value
    : undefined;

const tokenRequest = (value: unknown): CloudflareAccessTokenRequest | undefined => {
  if (!isRecord(value)) return undefined;
  const requestedAudience = optionalString(value.audience);
  const expiresInSeconds = optionalExpiry(value.expiresInSeconds);
  if (value.expiresInSeconds !== undefined && expiresInSeconds === undefined) return undefined;

  if (
    value.kind === "human" &&
    typeof value.subject === "string" &&
    value.subject.length > 0 &&
    typeof value.email === "string" &&
    value.email.length > 0
  ) {
    const groups = optionalStringArray(value.groups);
    if (value.groups !== undefined && groups === undefined) return undefined;
    return {
      kind: "human",
      subject: value.subject,
      email: value.email,
      ...(optionalString(value.name) ? { name: optionalString(value.name) } : {}),
      ...(groups ? { groups } : {}),
      ...(requestedAudience ? { audience: requestedAudience } : {}),
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    };
  }

  if (
    value.kind === "service" &&
    typeof value.commonName === "string" &&
    value.commonName.length > 0
  ) {
    return {
      kind: "service",
      commonName: value.commonName,
      ...(requestedAudience ? { audience: requestedAudience } : {}),
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    };
  }
  return undefined;
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const issue = (request: CloudflareAccessTokenRequest) => {
  const now = Math.floor(Date.now() / 1_000);
  const claims: Record<string, unknown> = {
    type: "app",
    aud: [request.audience ?? audience],
    iss: issuer,
    iat: now,
    exp: now + (request.expiresInSeconds ?? 300),
    ...(request.kind === "human"
      ? {
          sub: request.subject,
          email: request.email,
          name: request.name ?? request.email,
          groups: request.groups ?? ["member"],
        }
      : { sub: "", common_name: request.commonName }),
  };
  const header = encode({ alg: "RS256", kid: keyId, typ: "JWT" });
  const payload = encode(claims);
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return { token: `${signingInput}.${signature}` };
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(request, response, url.pathname, 200, "health.read", { ok: true, bootNonce });
    return;
  }
  if (request.method === "GET" && url.pathname === "/cdn-cgi/access/certs") {
    sendJson(
      request,
      response,
      url.pathname,
      200,
      "jwks.read",
      { keys: [jwk] },
      {
        headers: { "cache-control": "public, max-age=60" },
      },
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/_e2e/ledger") {
    sendJson(
      request,
      response,
      url.pathname,
      200,
      "ledger.read",
      { entries: [...ledger] },
      {
        headers: { "cache-control": "no-store" },
      },
    );
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/_e2e/issue") {
    sendJson(request, response, url.pathname, 404, "route.not-found", { error: "not found" });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  request.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (tooLarge) {
      sendJson(request, response, url.pathname, 413, "token.issue.rejected", {
        error: "request body too large",
      });
      return;
    }
    let value: unknown;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: malformed control-plane JSON becomes an HTTP 400
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(request, response, url.pathname, 400, "token.issue.rejected", {
        error: "invalid JSON",
      });
      return;
    }
    const parsed = tokenRequest(value);
    if (!parsed) {
      sendJson(request, response, url.pathname, 400, "token.issue.rejected", {
        error: "invalid token request",
      });
      return;
    }
    sendJson(request, response, url.pathname, 200, "token.issue", issue(parsed), {
      headers: { "cache-control": "no-store" },
      tokenKind: parsed.kind,
    });
  });
});

server.on("error", (error) => {
  console.error(`cloudflare-access-emulator: ${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`cloudflare-access-emulator: ${issuer}`);
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
