import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "./testing/mint-invite";

// Point config at a throwaway data dir before importing the app graph.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-apps-"));
process.env.BETTER_AUTH_SECRET = "apps-node-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@apps-node.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};
let token = "";

// A JSON fetch that carries the bearer (the apps HTTP surface is authenticated).
const authed = (path: string, init?: RequestInit) =>
  handler(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    }),
  );

beforeAll(async () => {
  // Boot the REAL self-host app handler (makeSelfHostApp), which mounts the apps
  // extension route under /api/apps/*.
  const { makeSelfHostApiHandler } = await import("./app");
  const app = await makeSelfHostApiHandler();
  handler = app.handler;
  dispose = app.dispose;

  // Sign up to get a bearer token (the apps surface is behind Better Auth).
  const inviteCode = await mintInviteCode(handler);
  const su = await handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "u@apps-node.test",
        password: "password-12345678",
        name: "U",
        inviteCode,
      }),
    }),
  );
  token = su.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
});
afterAll(() => dispose());

// Fix 1: the apps HTTP surface rejects unauthenticated requests with 401.
test("apps HTTP surface requires auth (401 without a credential)", async () => {
  // publish / invoke / workflow-start / SSE all 401 unauthenticated.
  const publish = await handler(
    new Request("http://localhost/api/apps/default/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: FILES }),
    }),
  );
  expect(publish.status).toBe(401);

  const invoke = await handler(
    new Request("http://localhost/api/apps/default/tools/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { text: "x" }, bindings: {} }),
    }),
  );
  expect(invoke.status).toBe(401);

  const sse = await handler(
    new Request("http://localhost/api/apps/default/live", { method: "GET" }),
  );
  expect(sse.status).toBe(401);
}, 30_000);

// A minimal published app: one tool that writes the scope db, and a ui view.
const FILES = {
  "tools/note.ts":
    `import { z } from "zod";\nimport { defineTool } from "executor:app";\n` +
    `export default defineTool({ description: "Save a note", input: z.object({ text: z.string() }), ` +
    `async handler({ text }, { db }) { await db.sql\`CREATE TABLE IF NOT EXISTS notes (t TEXT)\`; ` +
    `await db.sql\`INSERT INTO notes (t) VALUES (\${text})\`; const rows = await db.sql\`SELECT COUNT(*) AS n FROM notes\`; return { count: Number(rows[0].n) }; } });`,
  "ui/board.tsx":
    `import { config } from "executor:ui";\nconfig({ title: "Board", maxHeight: 400 });\n` +
    `export default function App() { return null; }`,
};

test("apps HTTP surface is mounted (authenticated): publish then serve the ui bundle", async () => {
  // Publish over the booted server's /api/apps/:scope/publish route (authed).
  const publishRes = await authed("/api/apps/default/publish", {
    method: "POST",
    body: JSON.stringify({ files: FILES }),
  });
  expect(publishRes.status).toBe(200);
  const published = (await publishRes.json()) as {
    descriptor: { tools: { name: string }[]; ui: { name: string }[] };
  };
  expect(published.descriptor.tools.map((t) => t.name)).toEqual(["note"]);
  expect(published.descriptor.ui.map((u) => u.name)).toEqual(["board"]);

  // The ui bundle is served (compiled JS) with its title header.
  const uiRes = await authed("/api/apps/default/ui/board", { method: "GET" });
  expect(uiRes.status).toBe(200);
  expect(uiRes.headers.get("content-type")).toContain("javascript");
  expect(uiRes.headers.get("x-ui-title")).toBe("Board");

  // The HTML document variant (Fix 10 fallback target) is served behind auth.
  const docRes = await authed("/api/apps/default/ui/board?document=html", { method: "GET" });
  expect(docRes.status).toBe(200);
  expect(docRes.headers.get("content-type")).toContain("text/html");

  // Invoke the tool (scope-db path is live in the running server).
  const invokeRes = await authed("/api/apps/default/tools/note", {
    method: "POST",
    body: JSON.stringify({ args: { text: "hello" }, bindings: {} }),
  });
  expect(invokeRes.status).toBe(200);
  const invoked = (await invokeRes.json()) as { result: { count: number } };
  expect(invoked.result.count).toBe(1);
}, 30_000);
