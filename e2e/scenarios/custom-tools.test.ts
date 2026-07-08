/* oxlint-disable executor/no-try-catch-or-throw -- boundary: e2e fixture server and raw HTTP assertions */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import type { BrowserSurface } from "../src/surfaces/browser";

const textEncoder = new TextEncoder();

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const pktLine = (payload: string | Uint8Array): Uint8Array => {
  const body = typeof payload === "string" ? textEncoder.encode(payload) : payload;
  const header = textEncoder.encode((body.length + 4).toString(16).padStart(4, "0"));
  return concat([header, body]);
};

const FLUSH = textEncoder.encode("0000");

const sideBand = (bytes: Uint8Array): Uint8Array => {
  const chunks: Uint8Array[] = [pktLine("NAK\n")];
  for (let offset = 0; offset < bytes.length; offset += 60_000) {
    const chunk = bytes.subarray(offset, offset + 60_000);
    const payload = new Uint8Array(chunk.length + 1);
    payload[0] = 1;
    payload.set(chunk, 1);
    chunks.push(pktLine(payload));
  }
  chunks.push(FLUSH);
  return concat(chunks);
};

const advertisement = (sha: string): Uint8Array =>
  concat([
    pktLine("# service=git-upload-pack\n"),
    FLUSH,
    pktLine(
      `${sha} HEAD\0symref=HEAD:refs/heads/main multi_ack side-band-64k thin-pack ofs-delta\n`,
    ),
    pktLine(`${sha} refs/heads/main\n`),
    FLUSH,
  ]);

const readFixture = async () => {
  const dir = join(import.meta.dirname, "..", "fixtures", "custom-tools-git");
  const [shas, pack1, pack2] = await Promise.all([
    readFile(join(dir, "custom-tools-shas.txt"), "utf8"),
    readFile(join(dir, "custom-tools-v1.pack")),
    readFile(join(dir, "custom-tools-v2.pack")),
  ]);
  const [sha1, sha2] = shas.trim().split("\n");
  return { sha1: sha1!, sha2: sha2!, pack1, pack2 };
};

const fixtureGitServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const fixture = await readFixture();
    let current = { sha: fixture.sha1, pack: new Uint8Array(fixture.pack1) };
    let packRequests = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.url === "/repo.git/info/refs?service=git-upload-pack") {
        response.writeHead(200, {
          "content-type": "application/x-git-upload-pack-advertisement",
        });
        response.end(advertisement(current.sha));
        return;
      }
      if (request.url === "/repo.git/git-upload-pack" && request.method === "POST") {
        packRequests += 1;
        response.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        response.end(sideBand(current.pack));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind");
    return {
      url: `http://127.0.0.1:${address.port}/repo.git`,
      advance: () => {
        current = { sha: fixture.sha2, pack: new Uint8Array(fixture.pack2) };
      },
      packRequests: () => packRequests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }),
  (server) => Effect.promise(() => server.close()).pipe(Effect.ignore),
);

interface ToolRow {
  readonly address: string;
  readonly name: string;
  readonly integration: string;
}

interface ExecuteResponse {
  readonly status: "completed" | "paused";
  readonly text: string;
  readonly structured: unknown;
  readonly isError?: boolean;
}

const authHeaders = async (
  target: TargetShape,
  identity: Identity,
): Promise<Record<string, string>> => {
  if (identity.headers) return identity.headers;
  const credentials = identity.credentials;
  if (!credentials) throw new Error(`identity ${identity.label} has no credentials`);
  const response = await fetch(new URL("/api/auth/sign-in/email", target.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(target.baseUrl).origin },
    body: JSON.stringify(credentials),
    redirect: "manual",
  });
  const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`sign-in set no cookie (${response.status})`);
  return { cookie };
};

const request = async <T>(
  target: TargetShape,
  identity: Identity,
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<{ readonly body: T; readonly text: string }> => {
  const headers = new Headers(init.headers);
  headers.set("origin", new URL(target.baseUrl).origin);
  for (const [name, value] of Object.entries(await authHeaders(target, identity))) {
    headers.set(name, value);
  }
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(new URL(path, target.baseUrl), { ...init, headers });
  const text = await response.text();
  expect(response.status, `${init.method ?? "GET"} ${path}: ${text}`).toBe(expectedStatus);
  return { body: (text.length > 0 ? JSON.parse(text) : null) as T, text };
};

const postJson = <T>(
  target: TargetShape,
  identity: Identity,
  path: string,
  body?: unknown,
  expectedStatus = 200,
): Promise<{ readonly body: T; readonly text: string }> =>
  request<T>(
    target,
    identity,
    path,
    {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    expectedStatus,
  );

const deletePath = (
  target: TargetShape,
  identity: Identity,
  path: string,
): Promise<{ readonly body: { readonly removed?: boolean }; readonly text: string }> =>
  request(target, identity, path, { method: "DELETE" });

const execute = (target: TargetShape, identity: Identity, code: string): Promise<ExecuteResponse> =>
  postJson<ExecuteResponse>(target, identity, "/api/executions", {
    code,
    autoApprove: true,
  }).then((response) => response.body);

const addSourceThroughConsole = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly identity: Identity;
  readonly sourceUrl: string;
}) =>
  input.browser.session(input.identity, async ({ page, step }) => {
    await step("Open the integrations page", async () => {
      await page.goto(new URL("/integrations", input.target.baseUrl).toString(), {
        waitUntil: "networkidle",
      });
    });

    await step("Detect the Git repository as custom tools", async () => {
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").fill(input.sourceUrl);
      await dialog.getByRole("button", { name: "Detect" }).click();
      await page.getByRole("heading", { name: "Add custom tools" }).waitFor();
    });

    await step("Sync the custom tools source", async () => {
      await page.locator('input[type="password"]').fill("fixture-token");
      await page.getByRole("button", { name: "Sync source" }).click();
      await page.waitForURL(/\/integrations\/apps(?:\?|$)/, { timeout: 90_000 });
      await page.getByText("2 tools").waitFor({ timeout: 90_000 });
    });
  });

const syncSourceInConsole = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly identity: Identity;
  readonly expectedNotice: string;
  readonly expectedToolCount: string;
}) =>
  input.browser.session(input.identity, async ({ page, step }) => {
    await step(`Sync custom tools and see ${input.expectedNotice}`, async () => {
      await page.goto(new URL("/integrations/apps?tab=source", input.target.baseUrl).toString(), {
        waitUntil: "networkidle",
      });
      await page.getByRole("button", { name: "Sync" }).click();
      await page.getByText(input.expectedNotice).waitFor({ timeout: 90_000 });
      await page
        .locator("p")
        .filter({ hasText: new RegExp(`^${input.expectedToolCount}$`) })
        .waitFor({ timeout: 90_000 });
    });
  });

const removeSourceThroughConsole = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly identity: Identity;
}) =>
  input.browser.session(input.identity, async ({ page, step }) => {
    await step("Remove the custom tools source", async () => {
      await page.goto(new URL("/integrations/apps?tab=source", input.target.baseUrl).toString(), {
        waitUntil: "networkidle",
      });
      await page.getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: "Remove source" }).click();
      await page.waitForURL(/\/integrations(?:\?|$)/, { timeout: 90_000 });
    });
  });

scenario(
  "Custom tools · Git source syncs, invokes, refreshes, and removes",
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      if (target.name !== "selfhost") return;
      const browser = yield* Browser;
      yield* Api;
      const identity = yield* target.newIdentity();
      const git = yield* fixtureGitServer;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const unauthorized = yield* Effect.promise(() =>
            fetch(new URL("/api/apps/sources/custom-tools/sync", target.baseUrl), {
              method: "POST",
            }),
          );
          expect(unauthorized.status, "sync requires authentication").toBe(401);
          yield* Effect.promise(() => unauthorized.text());

          yield* addSourceThroughConsole({ target, browser, identity, sourceUrl: git.url });

          const sources = yield* Effect.promise(() =>
            request<{
              readonly sources: readonly {
                readonly slug: string;
                readonly app: string;
                readonly config: { readonly kind: string; readonly url?: string };
              }[];
            }>(target, identity, "/api/apps/sources"),
          );
          expect(sources.text).not.toContain("fixture-token");
          const source = sources.body.sources.find((item) => item.app === "repo");
          expect(source).toMatchObject({
            app: "repo",
            config: { kind: "git", url: git.url },
          });

          const tools = yield* Effect.promise(() =>
            request<readonly ToolRow[]>(target, identity, "/api/tools?integration=apps"),
          );
          expect(tools.body.map((tool) => tool.name).sort()).toEqual(["echo-tool", "static-tool"]);
          const echoTool = tools.body.find((tool) => tool.name === "echo-tool");
          expect(echoTool).toBeDefined();

          const schema = yield* Effect.promise(() =>
            request<{
              readonly inputSchema: {
                readonly properties?: Record<
                  string,
                  {
                    readonly type?: string;
                    readonly enum?: readonly string[];
                    readonly default?: unknown;
                  }
                >;
                readonly required?: readonly string[];
              };
            }>(
              target,
              identity,
              `/api/tools/schema?address=${encodeURIComponent(echoTool!.address)}`,
            ),
          );
          expect(schema.body.inputSchema.properties?.apps).toMatchObject({
            enum: ["tools.apps.org.published"],
            default: "tools.apps.org.published",
          });
          expect(schema.body.inputSchema.properties?.message).toMatchObject({ type: "string" });
          expect(schema.body.inputSchema.required ?? []).toContain("message");
          expect(schema.body.inputSchema.required ?? []).not.toContain("apps");

          const invoked = yield* Effect.promise(() =>
            execute(
              target,
              identity,
              `return await tools["apps.org.published.echo-tool"]({ message: "hello", apps: "tools.apps.org.published" });`,
            ),
          );
          expect(invoked.status, invoked.text).toBe("completed");
          expect(invoked.isError, invoked.text).toBe(false);
          expect(JSON.stringify(invoked.structured)).toContain("hello");
          expect(JSON.stringify(invoked.structured)).toContain("v1");

          expect(git.packRequests(), "initial publish fetched one pack").toBe(1);
          git.advance();
          yield* syncSourceInConsole({
            target,
            browser,
            identity,
            expectedNotice: "Added: extra-tool",
            expectedToolCount: "3 tools",
          });

          yield* syncSourceInConsole({
            target,
            browser,
            identity,
            expectedNotice: "Already up to date.",
            expectedToolCount: "3 tools",
          });

          yield* removeSourceThroughConsole({ target, browser, identity });

          const afterRemove = yield* Effect.promise(() =>
            request<readonly ToolRow[]>(target, identity, "/api/tools?integration=apps"),
          );
          expect(afterRemove.body).toEqual([]);
        }),
        Effect.promise(async () => {
          const sources = await request<{
            readonly sources: readonly { readonly slug: string; readonly app: string }[];
          }>(target, identity, "/api/apps/sources").catch(() => ({ body: { sources: [] } }));
          for (const source of sources.body.sources) {
            if (source.app === "repo") {
              await deletePath(
                target,
                identity,
                `/api/apps/sources/${encodeURIComponent(source.slug)}`,
              ).catch(() => undefined);
            }
          }
        }).pipe(Effect.ignore),
      );
    }),
  ),
);
