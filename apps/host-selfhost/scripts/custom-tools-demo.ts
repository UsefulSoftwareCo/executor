import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? "8791");
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const ORIGIN = "http://custom-tools-demo.local";
const DEMO_REPO = "RhysSullivan/executor-custom-tools-demo";
const ADMIN_EMAIL = "admin@custom-tools-demo.local";
const ADMIN_PASSWORD = "admin-pass-123456";
const USER_EMAIL = "rhys@custom-tools-demo.local";
const USER_PASSWORD = "password-12345678";
const GITHUB_CONNECTION_NAME = "main";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-custom-tools-demo-"));
process.env.BETTER_AUTH_SECRET = "custom-tools-demo-better-auth-secret-0123456789";
process.env.EXECUTOR_SECRET_KEY = "custom-tools-demo-secret-key-0123456789";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = ADMIN_EMAIL;
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.EXECUTOR_BOOTSTRAP_ADMIN_NAME = "Demo Admin";
process.env.EXECUTOR_ORG_NAME = "Custom Tools Demo";
process.env.EXECUTOR_ORG_SLUG = "custom-tools-demo";
process.env.EXECUTOR_WEB_BASE_URL = BASE_URL;
process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = "true";

const log = (...args: unknown[]) => console.log("[custom-tools-demo]", ...args);

const run = async (cmd: readonly string[]): Promise<string> => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
};

const githubToken = async (): Promise<string> => {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return await run(["gh", "auth", "token"]);
  } catch (error) {
    throw new Error(
      "Set GITHUB_TOKEN or run `gh auth login` before starting the custom-tools demo.",
      { cause: error },
    );
  }
};

const bearerTemplate = {
  slug: "bearer",
  type: "apiKey",
  label: "GitHub token",
  headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
};

const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});

const queryParam = (name: string, schema: Record<string, unknown>, description: string) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

const githubRestSpec = JSON.stringify({
  openapi: "3.0.3",
  info: {
    title: "GitHub REST",
    version: "demo",
    description: "Minimal GitHub REST surface for the custom-tools demo.",
  },
  servers: [{ url: "https://api.github.com" }],
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "repos/get",
        "x-executor-toolPath": "repos.get",
        tags: ["repos"],
        summary: "Get repository metadata",
        parameters: [pathParam("owner", "Repository owner"), pathParam("repo", "Repository name")],
        responses: {
          "200": {
            description: "Repository",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    full_name: { type: "string" },
                    description: { type: "string", nullable: true },
                    html_url: { type: "string" },
                    stargazers_count: { type: "number" },
                    forks_count: { type: "number" },
                    open_issues_count: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/repos/{owner}/{repo}/issues": {
      get: {
        operationId: "issues/listForRepo",
        "x-executor-toolPath": "issues.listForRepo",
        tags: ["issues"],
        summary: "List repository issues",
        parameters: [
          pathParam("owner", "Repository owner"),
          pathParam("repo", "Repository name"),
          queryParam("state", { type: "string", enum: ["open", "closed", "all"] }, "Issue state"),
          queryParam(
            "sort",
            { type: "string", enum: ["created", "updated", "comments"] },
            "Sort field",
          ),
          queryParam("direction", { type: "string", enum: ["asc", "desc"] }, "Sort direction"),
          queryParam("since", { type: "string" }, "Only issues updated after this ISO timestamp"),
          queryParam("per_page", { type: "number" }, "Page size"),
          queryParam("page", { type: "number" }, "Page number"),
        ],
        responses: {
          "200": {
            description: "Issues",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      number: { type: "number" },
                      title: { type: "string" },
                      html_url: { type: "string" },
                      updated_at: { type: "string" },
                      state: { type: "string" },
                      pull_request: { type: "object", nullable: true },
                      labels: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { name: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/repos/{owner}/{repo}/releases": {
      get: {
        operationId: "repos/listReleases",
        "x-executor-toolPath": "repos.listReleases",
        tags: ["repos"],
        summary: "List repository releases",
        parameters: [
          pathParam("owner", "Repository owner"),
          pathParam("repo", "Repository name"),
          queryParam("per_page", { type: "number" }, "Page size"),
          queryParam("page", { type: "number" }, "Page number"),
        ],
        responses: {
          "200": {
            description: "Releases",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      tag_name: { type: "string" },
                      name: { type: "string", nullable: true },
                      html_url: { type: "string" },
                      published_at: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

const responseJson = async (response: Response): Promise<JsonResponse> => {
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
};

const mustJson = async <T>(response: Response, label: string): Promise<T> => {
  const parsed = await responseJson(response);
  if (parsed.status < 200 || parsed.status >= 300) {
    throw new Error(`${label} failed (${parsed.status}): ${JSON.stringify(parsed.body)}`);
  }
  return parsed.body as T;
};

const htmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const toolInvokeCode = (toolName: string, args: unknown): string => `
const found = await tools.search({ namespace: "apps", query: ${JSON.stringify(toolName)}, limit: 20 });
const item = found.items.find((candidate) => candidate.path.endsWith(${JSON.stringify(toolName)}));
if (!item) return { ok: false, missing: ${JSON.stringify(toolName)}, found };
let fn = tools;
for (const segment of item.path.split(".")) fn = fn[segment];
return await fn(${JSON.stringify(args)});
`;

const curlJson = (path: string, body: unknown): string =>
  `curl -sS -X POST ${BASE_URL}${path} -H 'content-type: application/json' -d '${JSON.stringify(body)}' | jq`;

const buildBanner = (input: {
  readonly repoUrl: string;
  readonly connectionAddress: string;
  readonly token: string;
  readonly consoleUi: string;
}): string => {
  const sync = curlJson("/api/apps/sources/github/sync", {
    repo: DEMO_REPO,
    connection: input.connectionAddress,
  });
  const list = `curl -sS '${BASE_URL}/api/tools?integration=apps' | jq`;
  const repoSummary = curlJson("/api/executions", {
    code: toolInvokeCode("repo-summary", {
      github: input.connectionAddress,
      repo: DEMO_REPO,
    }),
    autoApprove: true,
  });
  const staleIssues = curlJson("/api/executions", {
    code: toolInvokeCode("stale-issues", {
      github: input.connectionAddress,
      repo: DEMO_REPO,
      staleDays: 30,
    }),
    autoApprove: true,
  });

  return `Custom tools demo ready

GitHub repo:
  ${input.repoUrl}

Local server:
  ${BASE_URL}

Console UI:
  ${input.consoleUi}

Auth:
  The local wrapper injects the self-host bearer into forwarded requests.
  Bearer for direct API debugging:
  ${input.token}

GitHub connection:
  ${input.connectionAddress}

Sync the repo:
  ${sync}

List published custom tools:
  ${list}

Invoke repo-summary:
  ${repoSummary}

Invoke stale-issues:
  ${staleIssues}

MCP endpoint:
  ${BASE_URL}/mcp
`;
};

const main = async () => {
  const token = await githubToken();

  const { makeSelfHostApiHandler } = await import("../src/app");
  const { mintInviteCode } = await import("../src/testing/mint-invite");
  const app = await makeSelfHostApiHandler();
  const handler = app.handler;

  const inviteCode = await mintInviteCode(handler, "admin");
  const signUp = await handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        name: "Rhys",
        inviteCode,
      }),
    }),
  );
  const selfHostToken = signUp.headers.get("set-auth-token");
  if (!selfHostToken) throw new Error("sign-up produced no self-host bearer token");

  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${selfHostToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );

  const consoleCheck = await handler(
    new Request(`${ORIGIN}/`, { headers: { authorization: `Bearer ${selfHostToken}` } }),
  );
  const consoleUi =
    consoleCheck.status === 404
      ? "not served by makeSelfHostApiHandler; use the curls below"
      : `${BASE_URL}/`;

  const addSpec = await api("/api/openapi/specs", {
    method: "POST",
    body: JSON.stringify({
      spec: { kind: "blob", value: githubRestSpec },
      slug: "github",
      name: "GitHub REST",
      description: "Minimal GitHub REST surface for the custom-tools demo.",
      baseUrl: "https://api.github.com",
      authenticationTemplate: [bearerTemplate],
    }),
  });
  if (addSpec.status !== 200 && addSpec.status !== 409) {
    const parsed = await responseJson(addSpec);
    throw new Error(
      `register github integration failed (${parsed.status}): ${JSON.stringify(parsed.body)}`,
    );
  }

  const created = await mustJson<{ address: string }>(
    await api("/api/connections", {
      method: "POST",
      body: JSON.stringify({
        owner: "user",
        name: GITHUB_CONNECTION_NAME,
        integration: "github",
        template: "bearer",
        value: token,
      }),
    }),
    "create github connection",
  );

  const banner = buildBanner({
    repoUrl: `https://github.com/${DEMO_REPO}`,
    connectionAddress: created.address,
    token: selfHostToken,
    consoleUi,
  });

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/") {
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Custom tools demo</title><pre>${htmlEscape(
            banner,
          )}</pre>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      const headers = new Headers(request.headers);
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${selfHostToken}`);
      return handler(new Request(request, { headers }));
    },
  });

  log(`serving at ${BASE_URL} (pid ${process.pid}, port ${server.port})`);
  console.log(banner);

  const shutdown = async () => {
    try {
      server.stop(true);
    } catch {
      /* ignore */
    }
    try {
      await app.dispose();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
};

await main();
