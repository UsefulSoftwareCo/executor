import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { createEmulator, type Emulator } from "@executor-js/emulate";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import type { BrowserSurface } from "../src/surfaces/browser";

const OWNER = "syncer";
const GITHUB_CONNECTION = "tools.github.user.main";

const unique = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`;

const bearerTemplate = {
  slug: "bearer",
  type: "apiKey",
  label: "Bearer token",
  headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
};

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const githubEmulator = (repo: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const port = yield* availablePort;
      return yield* Effect.promise(() =>
        createEmulator({
          service: "github",
          port,
          seed: {
            github: {
              users: [{ login: OWNER, name: "Custom Tools Syncer" }],
              repos: [{ owner: OWNER, name: repo, auto_init: true }],
            },
          },
        }),
      );
    }),
    (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
  );

interface SyncResult {
  readonly status: "published" | "up-to-date" | "failed";
  readonly snapshotId?: string;
  readonly upstreamSha?: string;
  readonly tools: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly errors?: readonly { readonly message?: string }[];
}

interface ToolRow {
  readonly address: string;
  readonly name: string;
  readonly integration: string;
}

interface ExecuteResponse {
  readonly status: "completed" | "paused";
  readonly text: string;
  readonly structured: {
    readonly result?: unknown;
    readonly error?: unknown;
  };
  readonly isError?: boolean;
}

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : null) as T;
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
  for (const [name, value] of Object.entries(identity.headers ?? {})) {
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
  body: unknown,
  expectedStatus = 200,
): Promise<{ readonly body: T; readonly text: string }> =>
  request<T>(
    target,
    identity,
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    expectedStatus,
  );

const deletePath = (
  target: TargetShape,
  identity: Identity,
  path: string,
): Promise<{ readonly status: number; readonly text: string }> =>
  fetch(new URL(path, target.baseUrl), {
    method: "DELETE",
    headers: {
      ...(identity.headers ?? {}),
      origin: new URL(target.baseUrl).origin,
    },
  }).then(async (response) => ({ status: response.status, text: await response.text() }));

const githubFetch = async <T>(
  emulator: Emulator,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/vnd.github+json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${emulator.url}${path}`, { ...init, headers });
  expect(response.ok, `${init.method ?? "GET"} ${path}: ${await response.clone().text()}`).toBe(
    true,
  );
  return parseJson<T>(response);
};

const createIssue = (
  emulator: Emulator,
  token: string,
  repo: string,
  title: string,
): Promise<unknown> =>
  githubFetch(emulator, token, `/repos/${OWNER}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });

const putRepoFiles = async (
  emulator: Emulator,
  token: string,
  repo: string,
  files: Readonly<Record<string, string>>,
): Promise<string> => {
  const ref = await githubFetch<{ object: { sha: string } }>(
    emulator,
    token,
    `/repos/${OWNER}/${repo}/git/ref/heads/main`,
  );
  const tree = await githubFetch<{ sha: string }>(
    emulator,
    token,
    `/repos/${OWNER}/${repo}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          content,
        })),
      }),
    },
  );
  const commit = await githubFetch<{ sha: string }>(
    emulator,
    token,
    `/repos/${OWNER}/${repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: `Update custom tools ${randomBytes(3).toString("hex")}`,
        tree: tree.sha,
        parents: [ref.object.sha],
      }),
    },
  );
  await githubFetch(emulator, token, `/repos/${OWNER}/${repo}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
};

const executorJson = JSON.stringify(
  {
    $schema: "https://executor.sh/schemas/executor.json",
    description: "Custom tools e2e fixture.",
  },
  null,
  2,
);

const dealPipelineSyncSource = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

export default defineTool({
  description: "Summarize open GitHub issues for pipeline review.",
  integrations: {
    github: integration("github"),
  },
  input: z.object({
    owner: z.string(),
    repo: z.string(),
  }),
  output: z.object({
    synced: z.number(),
    issues: z.array(z.object({ number: z.number(), title: z.string() })),
  }),
  annotations: { readOnly: false, destructive: false },
  async handler({ owner, repo }, { github }) {
    const issues = await github.repos.listIssues({ owner, repo, state: "open" });
    return {
      synced: issues.length,
      issues: issues.map((issue) => ({ number: issue.number, title: issue.title })),
    };
  },
});
`;

const findDealDocsSource = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

export default defineTool({
  description: "Return issue titles as deal-document search results.",
  integrations: {
    github: integration("github"),
  },
  input: z.object({
    owner: z.string(),
    repo: z.string(),
    limit: z.number().int().max(50).default(20),
  }),
  output: z.object({
    documents: z.array(z.object({ name: z.string(), number: z.number() })),
  }),
  annotations: { readOnly: true, destructive: false },
  async handler({ owner, repo, limit }, { github }) {
    const issues = await github.repos.listIssues({ owner, repo, state: "open" });
    return {
      documents: issues.slice(0, limit).map((issue) => ({
        name: issue.title,
        number: issue.number,
      })),
    };
  },
});
`;

const extraToolSource = `import { z } from "zod";
import { defineTool } from "executor:app";

export default defineTool({
  description: "Return a static custom-tools health marker.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  annotations: { readOnly: true, destructive: false },
  async handler() {
    return { ok: true };
  },
});
`;

const sourceFiles = (): Record<string, string> => ({
  "executor.json": executorJson,
  "tools/deal-pipeline-sync.ts": dealPipelineSyncSource,
  "tools/find-deal-docs.ts": findDealDocsSource,
});

const sourceUrl = (repo: string): string => `https://github.com/${OWNER}/${repo}`;

const registerGithubIntegration = async (
  target: TargetShape,
  identity: Identity,
  emulator: Emulator,
  token: string,
): Promise<void> => {
  await deletePath(target, identity, "/api/connections/user/github/main");
  await deletePath(target, identity, "/api/openapi/integrations/github");
  const added = await postJson<{ slug?: string }>(target, identity, "/api/openapi/specs", {
    spec: { kind: "url", url: emulator.openapiUrl },
    slug: "github",
    baseUrl: emulator.url,
    authenticationTemplate: [bearerTemplate],
  });
  expect(added.body.slug).toBe("github");
  const connection = await postJson<{ address: string }>(target, identity, "/api/connections", {
    owner: "user",
    name: "main",
    integration: "github",
    template: "bearer",
    value: token,
  });
  expect(connection.body.address).toBe(GITHUB_CONNECTION);
};

const execute = (target: TargetShape, identity: Identity, code: string): Promise<ExecuteResponse> =>
  postJson<ExecuteResponse>(target, identity, "/api/executions", {
    code,
    autoApprove: true,
  }).then((response) => response.body);

const executeResult = async (
  target: TargetShape,
  identity: Identity,
  code: string,
): Promise<unknown> => {
  const response = await execute(target, identity, code);
  expect(response.status, response.text).toBe("completed");
  expect(response.isError, response.text).toBe(false);
  return response.structured.result;
};

const callAppToolCode = (namespace: string, toolName: string, args: unknown): string => `
const found = await tools.search({ namespace: ${JSON.stringify(namespace)}, query: ${JSON.stringify(
  toolName,
)}, limit: 20 });
const item = found.items.find((candidate) => candidate.path.endsWith(${JSON.stringify(toolName)}));
if (!item) return { ok: false, missing: ${JSON.stringify(toolName)}, found };
let fn = tools;
for (const segment of item.path.split(".")) fn = fn[segment];
const result = await fn(${JSON.stringify(args)});
return { path: item.path, result };
`;

const addSourceThroughConsole = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly identity: Identity;
  readonly repo: string;
  readonly appSlug: string;
  readonly token: string;
}) =>
  input.browser.session(input.identity, async ({ page, step }) => {
    await step("Open the integrations page", async () => {
      await page.goto(new URL("/integrations", input.target.baseUrl).toString(), {
        waitUntil: "networkidle",
      });
    });

    await step("Detect the GitHub repository as custom tools", async () => {
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").fill(sourceUrl(input.repo));
      await dialog.getByRole("button", { name: "Detect" }).click();
      await page.getByRole("heading", { name: "Add custom tools" }).waitFor();
    });

    await step("Sync the custom tools source", async () => {
      await page.locator('input[type="password"]').fill(input.token);
      await page.getByRole("button", { name: "Sync repo" }).click();
      await page.waitForURL(new RegExp(`/integrations/${input.appSlug}(?:\\?|$)`), {
        timeout: 60_000,
      });
      await page.getByRole("link", { name: "2 tools" }).waitFor({ timeout: 60_000 });
    });
  });

const syncSourceInConsole = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly identity: Identity;
  readonly appSlug: string;
  readonly expectedNotice: string;
  readonly expectedToolCount: string;
}) =>
  input.browser.session(input.identity, async ({ page, step }) => {
    await step(`Sync ${input.appSlug}`, async () => {
      await page.goto(
        new URL(`/integrations/${input.appSlug}?tab=source`, input.target.baseUrl).toString(),
        {
          waitUntil: "networkidle",
        },
      );
      await page.getByRole("button", { name: "Sync" }).click();
      await page.getByText(input.expectedNotice).waitFor({ timeout: 60_000 });
      await page.getByRole("link", { name: input.expectedToolCount }).waitFor({ timeout: 60_000 });
    });
  });

const removeSourceThroughConsole = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly identity: Identity;
  readonly appSlug: string;
}) =>
  input.browser.session(input.identity, async ({ page, step }) => {
    await step("Remove the custom tools source", async () => {
      await page.goto(
        new URL(`/integrations/${input.appSlug}?tab=source`, input.target.baseUrl).toString(),
        {
          waitUntil: "networkidle",
        },
      );
      await page.getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: "Remove source" }).click();
      await page.waitForURL(/\/integrations(?:\?|$)/, { timeout: 60_000 });
    });
  });

scenario(
  "Custom tools · GitHub source syncs, invokes, refreshes, and removes",
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      if (target.name !== "selfhost") return;
      const browser = yield* Browser;
      yield* Api;
      const identity = yield* target.newIdentity();
      const repo = unique("custom-tools");
      const appSlug = repo;
      const emulator = yield* githubEmulator(repo);
      const credential = yield* Effect.promise(() =>
        emulator.credentials.mint({ type: "api-key", login: OWNER, scopes: ["repo", "user"] }),
      );
      const token = credential.token;
      if (!token) return yield* Effect.die("GitHub emulator did not mint a token.");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const unauthorized = yield* Effect.promise(() =>
            fetch(new URL("/api/apps/sources/github/sync", target.baseUrl), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: sourceUrl(repo), token }),
            }),
          );
          expect(unauthorized.status, "sync requires authentication").toBe(401);
          yield* Effect.promise(() => unauthorized.text());

          yield* Effect.promise(() => registerGithubIntegration(target, identity, emulator, token));
          yield* Effect.promise(() => createIssue(emulator, token, repo, "Acme renewal diligence"));
          yield* Effect.promise(() => createIssue(emulator, token, repo, "Beta pipeline memo"));
          yield* Effect.promise(() => putRepoFiles(emulator, token, repo, sourceFiles()));

          yield* addSourceThroughConsole({ target, browser, identity, repo, appSlug, token });

          const sources = yield* Effect.promise(() =>
            request<{ sources: readonly { readonly slug: string; readonly hasToken: boolean }[] }>(
              target,
              identity,
              "/api/apps/sources/github",
            ),
          );
          expect(sources.text).not.toContain(token);
          expect(sources.body.sources.find((source) => source.slug === appSlug)?.hasToken).toBe(
            true,
          );

          const detail = yield* Effect.promise(() =>
            request<{ source: { readonly slug: string; readonly hasToken: boolean } | null }>(
              target,
              identity,
              `/api/apps/sources/github/${encodeURIComponent(appSlug)}`,
            ),
          );
          expect(detail.text).not.toContain(token);
          expect(detail.body.source).toMatchObject({ slug: appSlug, hasToken: true });

          const tools = yield* Effect.promise(() =>
            request<readonly ToolRow[]>(
              target,
              identity,
              `/api/tools?integration=${encodeURIComponent(appSlug)}`,
            ),
          );
          expect(tools.body.map((tool) => tool.name).sort()).toEqual([
            "deal-pipeline-sync",
            "find-deal-docs",
          ]);
          const syncTool = tools.body.find((tool) => tool.name === "deal-pipeline-sync");
          expect(syncTool).toBeDefined();

          const schema = yield* Effect.promise(() =>
            request<{
              inputSchema: {
                readonly properties?: Record<
                  string,
                  { readonly enum?: readonly string[]; readonly default?: string }
                >;
                readonly required?: readonly string[];
              };
            }>(
              target,
              identity,
              `/api/tools/schema?address=${encodeURIComponent(syncTool!.address)}`,
            ),
          );
          expect(schema.body.inputSchema.properties?.github).toMatchObject({
            enum: [GITHUB_CONNECTION],
            default: GITHUB_CONNECTION,
          });
          expect(schema.body.inputSchema.required ?? []).not.toContain("github");

          const invoked = (yield* Effect.promise(() =>
            executeResult(
              target,
              identity,
              callAppToolCode(appSlug, "deal-pipeline-sync", { owner: OWNER, repo }),
            ),
          )) as {
            readonly result?: {
              readonly ok?: boolean;
              readonly data?: { readonly synced?: number };
            };
          };
          expect(invoked.result?.ok).toBe(true);
          expect(invoked.result?.data?.synced).toBe(2);

          const ledger = yield* Effect.promise(() => emulator.ledger.list());
          const issueList = ledger.find(
            (entry) =>
              entry.operationId === "issues/listForRepo" &&
              entry.path === `/repos/${OWNER}/${repo}/issues`,
          );
          expect(
            issueList?.identity.user?.login,
            "custom tool called GitHub with the connection",
          ).toBe(OWNER);

          const upToDate = yield* Effect.promise(() =>
            postJson<SyncResult>(target, identity, "/api/apps/sources/github/sync", {
              slug: appSlug,
            }),
          );
          expect(upToDate.text).not.toContain(token);
          expect(upToDate.body.status).toBe("up-to-date");

          yield* syncSourceInConsole({
            target,
            browser,
            identity,
            appSlug,
            expectedNotice: "Already up to date.",
            expectedToolCount: "2 tools",
          });

          yield* Effect.promise(() =>
            putRepoFiles(emulator, token, repo, {
              ...sourceFiles(),
              "tools/extra-tool.ts": extraToolSource,
            }),
          );
          yield* syncSourceInConsole({
            target,
            browser,
            identity,
            appSlug,
            expectedNotice: "Added: extra-tool",
            expectedToolCount: "3 tools",
          });

          yield* Effect.promise(() => putRepoFiles(emulator, token, repo, sourceFiles()));
          yield* syncSourceInConsole({
            target,
            browser,
            identity,
            appSlug,
            expectedNotice: "Removed: extra-tool",
            expectedToolCount: "2 tools",
          });

          yield* removeSourceThroughConsole({ target, browser, identity, appSlug });

          const afterRemove = yield* Effect.promise(() =>
            request<readonly ToolRow[]>(
              target,
              identity,
              `/api/tools?integration=${encodeURIComponent(appSlug)}`,
            ),
          );
          expect(afterRemove.body).toEqual([]);
        }),
        Effect.promise(async () => {
          await deletePath(
            target,
            identity,
            `/api/apps/sources/github/${encodeURIComponent(appSlug)}`,
          );
          await deletePath(target, identity, "/api/connections/user/github/main");
          await deletePath(target, identity, "/api/openapi/integrations/github");
        }).pipe(Effect.ignore),
      );
    }),
  ),
);
