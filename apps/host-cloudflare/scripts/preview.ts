// Per-PR preview deploys of the Cloudflare host.
//
// Each pull request gets its own fully isolated stack on a dedicated
// Cloudflare account: a Worker (`executor-preview-pr-<n>`), its own D1
// database, a fresh EXECUTOR_SECRET_KEY, and its own Cloudflare Access
// application (MCP-OAuth-aware, gating the workers.dev hostname at the edge)
// so previews are never publicly open. The R2 blob bucket is shared across
// previews (`executor-preview-blobs`) — blobs are content-addressed overflow
// values reached only via pointers in each preview's private D1, and leaving
// the bucket in place keeps teardown trivial.
//
// Teardown is stateless by naming convention: everything a preview owns is
// derived from its PR number, so `destroy` (and the scheduled sweeper) can
// clean up without any deploy-time state.
//
//   bun scripts/preview.ts deploy --pr 123 [--skip-build]
//   bun scripts/preview.ts destroy --pr 123
//   bun scripts/preview.ts list            # JSON [{pr, name}] of live previews
//   bun scripts/preview.ts sweep-e2e       # clean e2e leftovers (see below)
//
// sweep-e2e cleans up after the e2e harness, which shares this account:
// suite runs that crash before their teardown leak an `executor-e2e-<hex>`
// worker + D1 + Access app trio, and every real Access OTP login by a
// synthetic ci-…@executor-dev.xyz identity permanently occupies a Zero Trust
// seat (50 on the free plan). Stacks older than a day are deleted; seats held
// by the synthetic domain are revoked. Persistent e2e infrastructure
// (executor-e2e-otp, executor-e2e-emulators, alchemy-state-store) is never
// touched.
//
// Env: CLOUDFLARE_API_TOKEN (Workers/D1/R2/Access edit) + CLOUDFLARE_ACCOUNT_ID
// always; deploy additionally needs PREVIEW_ACCESS_TEAM_DOMAIN (Zero Trust team)
// and PREVIEW_ACCESS_EMAILS (comma-separated emails allowed through Access; the
// first one is also the admin unless PREVIEW_ADMIN_EMAILS overrides it).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CF_API = "https://api.cloudflare.com/client/v4";
const APP_DIR = resolve(import.meta.dirname, "..");
const WORKER_PREFIX = "executor-preview-pr-";
const SHARED_BLOBS_BUCKET = "executor-preview-blobs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

interface CfFetchResult {
  readonly ok: boolean;
  readonly errors: string;
  readonly result: any;
}

const cf = async (method: string, path: string, body?: unknown): Promise<CfFetchResult> => {
  const response = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await response.json().catch(() => ({ success: false, errors: [] }));
  return {
    ok: json.success === true,
    errors: JSON.stringify(json.errors ?? []),
    result: json.result,
  };
};

const cfOk = async (method: string, path: string, body?: unknown): Promise<any> => {
  const response = await cf(method, path, body);
  if (!response.ok) fail(`${method} ${path} failed: ${response.errors}`);
  return response.result;
};

/** Paginated GET that concatenates every page of `result`. */
const cfList = async (path: string): Promise<any[]> => {
  const all: any[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const items = await cfOk("GET", `${path}${separator}page=${page}&per_page=100`);
    all.push(...items);
    if (items.length < 100) return all;
  }
};

const run = (command: string, args: string[], options?: { input?: string; cwd?: string }): void => {
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? APP_DIR,
    stdio: [options?.input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    input: options?.input,
    env: process.env,
  });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}`);
};

const prNumber = (): number => {
  const index = process.argv.indexOf("--pr");
  const value = index === -1 ? Number.NaN : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) fail("--pr <number> is required");
  return value;
};

const workerName = (pr: number): string => `${WORKER_PREFIX}${pr}`;

// --- resources ---------------------------------------------------------------

const findD1 = async (name: string): Promise<string | null> => {
  const databases = await cfList(`/accounts/${ACCOUNT}/d1/database?name=${name}`);
  const match = databases.find((database: any) => database.name === name);
  return match ? match.uuid : null;
};

const ensureD1 = async (name: string): Promise<string> => {
  const existing = await findD1(name);
  if (existing) {
    process.stderr.write(`reusing D1 ${name} (${existing})\n`);
    return existing;
  }
  const created = await cfOk("POST", `/accounts/${ACCOUNT}/d1/database`, {
    name,
  });
  process.stderr.write(`created D1 ${name} (${created.uuid})\n`);
  return created.uuid;
};

const ensureSharedBucket = async (): Promise<void> => {
  const existing = await cf("GET", `/accounts/${ACCOUNT}/r2/buckets/${SHARED_BLOBS_BUCKET}`);
  if (existing.ok) return;
  const created = await cf("POST", `/accounts/${ACCOUNT}/r2/buckets`, {
    name: SHARED_BLOBS_BUCKET,
  });
  if (!created.ok) fail(`creating R2 bucket ${SHARED_BLOBS_BUCKET} failed: ${created.errors}`);
  process.stderr.write(`created shared R2 bucket ${SHARED_BLOBS_BUCKET}\n`);
};

const workersSubdomain = async (): Promise<string> => {
  const result = await cfOk("GET", `/accounts/${ACCOUNT}/workers/subdomain`);
  return result.subdomain;
};

const findAccessApp = async (name: string): Promise<any | null> => {
  const apps = await cfList(`/accounts/${ACCOUNT}/access/apps`);
  return apps.find((app: any) => app.name === name) ?? null;
};

/**
 * One Access application per preview, gating its workers.dev hostname at the
 * edge. `oauth_configuration` must be present AT CREATION for the app to speak
 * MCP OAuth (401 + resource_metadata challenge with Access as the authorization
 * server, dynamic client registration for local MCP clients) — without it,
 * unauthenticated /mcp requests get a browser login redirect instead.
 */
const ensureAccessApp = async (
  name: string,
  hostname: string,
  allowedEmails: readonly string[],
): Promise<{ id: string; aud: string }> => {
  const existing = await findAccessApp(name);
  if (existing) {
    process.stderr.write(`reusing Access app ${name} (aud ${existing.aud.slice(0, 8)}…)\n`);
    return { id: existing.id, aud: existing.aud };
  }
  const app = await cfOk("POST", `/accounts/${ACCOUNT}/access/apps`, {
    name,
    type: "self_hosted",
    domain: hostname,
    session_duration: "24h",
    oauth_configuration: {
      enabled: true,
      grant: { session_duration: "24h", access_token_lifetime: "15m" },
      dynamic_client_registration: {
        enabled: true,
        allowed_uris: [],
        allow_any_on_localhost: true,
        allow_any_on_loopback: true,
      },
    },
  });
  await cfOk("POST", `/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, {
    name: `${name}-allowed-emails`,
    decision: "allow",
    include: allowedEmails.map((email) => ({ email: { email } })),
  });
  process.stderr.write(`created Access app ${name} for ${hostname}\n`);
  return { id: app.id, aud: app.aud };
};

/**
 * Derive the preview wrangler config from the committed one (same bindings,
 * preview-specific names) so previews always deploy the real config users get.
 * Each substitution is asserted so config drift fails loudly here instead of
 * silently deploying previews against the wrong resources.
 */
const writePreviewConfig = (worker: string, databaseName: string, databaseId: string): string => {
  const basePath = resolve(APP_DIR, "wrangler.jsonc");
  let text = readFileSync(basePath, "utf8");
  const substitute = (pattern: RegExp, replacement: string): void => {
    if (!pattern.test(text))
      fail(`wrangler.jsonc no longer matches ${pattern} — update preview.ts`);
    text = text.replace(pattern, replacement);
  };
  substitute(/"name":\s*"executor-cloudflare"/, `"name": "${worker}"`);
  substitute(/"database_name":\s*"[^"]*"/, `"database_name": "${databaseName}"`);
  substitute(/"database_id":\s*"[^"]*"/, `"database_id": "${databaseId}"`);
  substitute(/"bucket_name":\s*"[^"]*"/, `"bucket_name": "${SHARED_BLOBS_BUCKET}"`);
  const outPath = resolve(APP_DIR, "wrangler.preview.jsonc");
  writeFileSync(outPath, `// Generated by scripts/preview.ts — do not edit.\n${text}`);
  return outPath;
};

// --- commands ----------------------------------------------------------------

const deploy = async (): Promise<void> => {
  const pr = prNumber();
  const worker = workerName(pr);
  const teamDomain = process.env.PREVIEW_ACCESS_TEAM_DOMAIN ?? "";
  const allowedEmails = (process.env.PREVIEW_ACCESS_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
  if (teamDomain.length === 0) fail("PREVIEW_ACCESS_TEAM_DOMAIN is required");
  if (allowedEmails.length === 0) fail("PREVIEW_ACCESS_EMAILS is required");
  const adminEmails = process.env.PREVIEW_ADMIN_EMAILS ?? allowedEmails[0]!;

  const databaseId = await ensureD1(worker);
  await ensureSharedBucket();
  const subdomain = await workersSubdomain();
  const hostname = `${worker}.${subdomain}.workers.dev`;
  const app = await ensureAccessApp(worker, hostname, allowedEmails);
  const configPath = writePreviewConfig(worker, worker, databaseId);

  // turbo so workspace dependencies with build steps (@executor-js/vite-plugin)
  // are built first — a fresh checkout has no dist/ anywhere.
  if (!process.argv.includes("--skip-build")) {
    run("bunx", ["turbo", "build", "--filter=@executor-js/host-cloudflare"], {
      cwd: resolve(APP_DIR, "../.."),
    });
  }
  run("bunx", [
    "wrangler",
    "deploy",
    "--config",
    configPath,
    "--var",
    `ACCESS_TEAM_DOMAIN:${teamDomain}`,
    "--var",
    `ACCESS_AUD:${app.aud}`,
    "--var",
    `ADMIN_EMAILS:${adminEmails}`,
  ]);

  // The at-rest encryption key: stable across redeploys of the same PR (a new
  // key would orphan secrets already stored in the preview's D1), fresh per
  // preview, set after deploy because the Worker must exist first.
  const secretList = spawnSync("bunx", ["wrangler", "secret", "list", "--config", configPath], {
    cwd: APP_DIR,
    encoding: "utf8",
    env: process.env,
  });
  if (!(secretList.stdout ?? "").includes("EXECUTOR_SECRET_KEY")) {
    run("bunx", ["wrangler", "secret", "put", "EXECUTOR_SECRET_KEY", "--config", configPath], {
      input: randomBytes(32).toString("hex"),
    });
  }

  const url = `https://${hostname}`;
  process.stderr.write(`preview live at ${url}\n`);
  process.stdout.write(`${JSON.stringify({ pr, worker, url, mcpUrl: `${url}/mcp` })}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\nworker=${worker}\n`);
  }
};

const destroy = async (): Promise<void> => {
  const pr = prNumber();
  const worker = workerName(pr);

  // force=true also removes the Worker's Durable Objects + their storage.
  const script = await cf("DELETE", `/accounts/${ACCOUNT}/workers/scripts/${worker}?force=true`);
  process.stderr.write(
    script.ok ? `deleted worker ${worker}\n` : `worker ${worker} already gone\n`,
  );

  const databaseId = await findD1(worker);
  if (databaseId) {
    await cfOk("DELETE", `/accounts/${ACCOUNT}/d1/database/${databaseId}`);
    process.stderr.write(`deleted D1 ${worker}\n`);
  }

  const app = await findAccessApp(worker);
  if (app) {
    await cfOk("DELETE", `/accounts/${ACCOUNT}/access/apps/${app.id}`);
    process.stderr.write(`deleted Access app ${worker}\n`);
  }
};

const list = async (): Promise<void> => {
  const scripts = await cfList(`/accounts/${ACCOUNT}/workers/scripts`);
  const previews = scripts
    .map((script: any) => String(script.id))
    .filter((id) => new RegExp(`^${WORKER_PREFIX}\\d+$`).test(id))
    .map((id) => ({ pr: Number(id.slice(WORKER_PREFIX.length)), name: id }))
    .sort((a, b) => a.pr - b.pr);
  process.stdout.write(`${JSON.stringify(previews)}\n`);
};

// E2e stacks are worker `executor-e2e-<8 hex>` + D1 `…-db` + Access app of the
// same name; the fixed-name workers are this account's persistent e2e infra.
const E2E_STACK_PATTERN = /^executor-e2e-[0-9a-f]{8}$/;
const E2E_SEAT_DOMAIN = "@executor-dev.xyz";
const E2E_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const sweepE2e = async (): Promise<void> => {
  const now = Date.now();
  const scripts = await cfList(`/accounts/${ACCOUNT}/workers/scripts`);
  const stale = scripts.filter((script: any) => {
    if (!E2E_STACK_PATTERN.test(String(script.id))) return false;
    const created = Date.parse(script.created_on ?? "");
    // Skip stacks younger than a day — they may belong to a live suite run.
    return Number.isFinite(created) && now - created > E2E_MIN_AGE_MS;
  });

  const databases = stale.length > 0 ? await cfList(`/accounts/${ACCOUNT}/d1/database`) : [];
  const apps = stale.length > 0 ? await cfList(`/accounts/${ACCOUNT}/access/apps`) : [];
  for (const script of stale) {
    const name = String(script.id);
    await cfOk("DELETE", `/accounts/${ACCOUNT}/workers/scripts/${name}?force=true`);
    process.stderr.write(`deleted e2e worker ${name}\n`);
    const database = databases.find((d: any) => d.name === `${name}-db`);
    if (database) {
      await cfOk("DELETE", `/accounts/${ACCOUNT}/d1/database/${database.uuid}`);
      process.stderr.write(`deleted e2e D1 ${name}-db\n`);
    }
    const app = apps.find((a: any) => a.name === name);
    if (app) {
      await cfOk("DELETE", `/accounts/${ACCOUNT}/access/apps/${app.id}`);
      process.stderr.write(`deleted e2e Access app ${name}\n`);
    }
  }

  // Seat revocation only — the user records stay (harmless), but they stop
  // counting against the Zero Trust seat quota.
  const users = await cfList(`/accounts/${ACCOUNT}/access/users`);
  const seated = users.filter(
    (user: any) =>
      String(user.email ?? "").endsWith(E2E_SEAT_DOMAIN) &&
      (user.access_seat === true || user.gateway_seat === true) &&
      typeof user.seat_uid === "string",
  );
  if (seated.length > 0) {
    await cfOk(
      "PATCH",
      `/accounts/${ACCOUNT}/access/seats`,
      seated.map((user: any) => ({
        seat_uid: user.seat_uid,
        access_seat: false,
        gateway_seat: false,
      })),
    );
    for (const user of seated) process.stderr.write(`revoked seat for ${user.email}\n`);
  }

  process.stdout.write(
    `${JSON.stringify({ deletedStacks: stale.map((s: any) => s.id), revokedSeats: seated.length })}\n`,
  );
};

// --- main --------------------------------------------------------------------

if (TOKEN.length === 0) fail("CLOUDFLARE_API_TOKEN is required");
if (ACCOUNT.length === 0) fail("CLOUDFLARE_ACCOUNT_ID is required");

const command = process.argv[2];
if (command === "deploy") await deploy();
else if (command === "destroy") await destroy();
else if (command === "list") await list();
else if (command === "sweep-e2e") await sweepE2e();
else fail("usage: preview.ts <deploy|destroy|list|sweep-e2e> [--pr <number>] [--skip-build]");
