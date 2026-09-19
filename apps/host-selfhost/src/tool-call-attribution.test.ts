import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";

// ---------------------------------------------------------------------------
// The tool call log names the CLIENT behind every call, not only the member:
// which API key, which CLI login, the browser console. Only the self-host
// identity layer sees the credential, so this boots the real app (real Better
// Auth, real API keys) and reads the rows back over the public API.
// ---------------------------------------------------------------------------

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-attribution-"));
process.env.BETTER_AUTH_SECRET = "attribution-secret-0123456789-abcdefghij-klmn";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "owner@attribution.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "owner-pass-123456";

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { makeSelfHostApiHandler } = await import("./app");
  const app = await makeSelfHostApiHandler();
  handler = app.handler;
  dispose = app.dispose;
});
afterAll(() => dispose());

const BASE = "http://localhost:4788";

interface ToolCallRow {
  readonly address: string;
  readonly actorLabel: string | null;
  readonly client: {
    readonly kind: string;
    readonly id: string | null;
    readonly name: string | null;
  } | null;
}

const signIn = async (): Promise<{ readonly token: string; readonly cookie: string }> => {
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        email: "owner@attribution.test",
        password: "owner-pass-123456",
      }),
    }),
  );
  expect(res.status).toBe(200);
  const token = res.headers.get("set-auth-token") ?? "";
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(token).not.toBe("");
  expect(cookie).not.toBe("");
  return { token, cookie };
};

const createApiKey = async (
  sessionToken: string,
  name: string,
): Promise<{ readonly id: string; readonly key: string }> => {
  const res = await handler(
    new Request(`${BASE}/api/auth/api-key/create`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        origin: BASE,
      },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; key: string };
};

// A core tool: no integration, no network, but a real trip through `execute`.
const CALL = "return await tools.executor.coreTools.policies.list({})";

const runCode = (headers: Record<string, string>) =>
  handler(
    new Request(`${BASE}/api/executions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ code: CALL }),
    }),
  );

const readToolCalls = async (sessionToken: string, query = ""): Promise<readonly ToolCallRow[]> => {
  const res = await handler(
    new Request(`${BASE}/api/tool-calls${query}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ToolCallRow[];
};

test("every tool call names the client it came in on", async () => {
  const { token, cookie } = await signIn();
  const apiKey = await createApiKey(token, "jean-mcp");

  // The same call three ways: an API key, the CLI's bearer session, the
  // browser's cookie.
  expect((await runCode({ authorization: `Bearer ${apiKey.key}` })).status).toBe(200);
  expect((await runCode({ authorization: `Bearer ${token}` })).status).toBe(200);
  expect((await runCode({ cookie })).status).toBe(200);

  const calls = await readToolCalls(token);
  const clients = calls.map((call) => call.client);
  expect(clients).toContainEqual({ kind: "api_key", id: apiKey.id, name: "jean-mcp" });
  expect(clients).toContainEqual({ kind: "cli", id: null, name: "CLI login" });
  expect(clients).toContainEqual({ kind: "session", id: null, name: "Web console" });
  // And WHO, on every one of them.
  for (const call of calls) expect(call.actorLabel).toBe("owner@attribution.test");

  // The API key's secret is never part of what is stored or served.
  expect(JSON.stringify(calls)).not.toContain(apiKey.key);
});

test("the log filters by client and lists the clients it has seen", async () => {
  const { token } = await signIn();

  const onlyKey = await readToolCalls(token, "?client=jean-mcp");
  expect(onlyKey.length).toBeGreaterThan(0);
  for (const call of onlyKey) expect(call.client?.name).toBe("jean-mcp");

  const res = await handler(
    new Request(`${BASE}/api/tool-calls/clients`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(res.status).toBe(200);
  const seen = (await res.json()) as readonly { readonly kind: string; readonly name: string }[];
  expect(seen.map((client) => client.name)).toEqual(
    expect.arrayContaining(["jean-mcp", "CLI login", "Web console"]),
  );
});
