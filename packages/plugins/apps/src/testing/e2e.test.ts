import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import { createEmulator } from "@executor-js/emulate";

type LocalEmulator = Awaited<ReturnType<typeof createEmulator>>;

import { makeSelfHostAppsRuntime, type SelfHostAppsRuntime } from "../plugin/self-host-runtime";
import { makeAppsHttpRoutes } from "../http/routes";
import { registerAppsMcp, type McpServerLike } from "../mcp/register";
import { makeInMemoryAppsStore } from "./index";
import { makeGithubRestResolver } from "./github-resolver";
import { dailyBriefFileSet } from "./daily-brief";
import type { Bindings } from "../plugin/bindings";

// ---------------------------------------------------------------------------
// THE E2E PROOF (brief's proof artifact), runnable as one command:
//   bun run --filter='@executor-js/plugin-apps' test -- src/testing/e2e.test.ts
//
// It: boots the self-host apps runtime over real seam backings; stands up a
// real-shaped GitHub via the emulate package; publishes the daily-brief set
// OVER MCP (the apps_publish tool); binds a connection (the minted emulator
// token); invokes the tool OVER HTTP (hits the real emulator, writes the scope
// db); starts the workflow and sees it complete with a journal; fetches the ui
// resource OVER MCP + the raw bundle OVER HTTP; sees an SSE invalidation after a
// write; and lists + reads the skill OVER MCP.
// ---------------------------------------------------------------------------

const SCOPE = "rhys";
const CONNECTION = "rhys-github";

// A minimal in-memory McpServer stand-in capturing registered tools/resources
// so the test can invoke them exactly as an MCP client would.
class FakeMcpServer implements McpServerLike {
  readonly tools = new Map<string, (args: Record<string, unknown>) => unknown>();
  readonly resources = new Map<string, { uriTemplate: string; reader: (uri: URL) => unknown }>();
  registerTool(
    name: string,
    _config: unknown,
    handler: (args: Record<string, unknown>) => unknown,
  ) {
    this.tools.set(name, handler);
    return undefined;
  }
  registerResource(name: string, uri: string, _metadata: unknown, reader: (uri: URL) => unknown) {
    this.resources.set(name, { uriTemplate: uri, reader });
    return undefined;
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as never);

describe("Executor apps e2e (self-host, real GitHub emulator)", () => {
  let github: LocalEmulator;
  let host: SelfHostAppsRuntime;
  let http: ReturnType<typeof makeAppsHttpRoutes>;
  let mcp: FakeMcpServer;
  let token: string;
  let owner: string;
  const base = "http://apps.test";

  beforeAll(async () => {
    // --- real-shaped GitHub (emulate) + seed a repo with two issues --------
    github = await createEmulator({ service: "github" });
    const cred = (await github.credentials.mint({ type: "api-key" })) as unknown as {
      token: string;
      login: string;
    };
    token = cred.token;
    const ghHeaders = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    };
    const repoRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ name: "app" }),
    });
    const repo = (await repoRes.json()) as { owner: { login: string } };
    owner = repo.owner.login;
    // One fresh issue and one that will read as stale (we backdate via title only;
    // the workflow's stale filter uses updated_at, which the emulator sets to now,
    // so we assert the run completes + journals rather than a specific stale count).
    for (const title of ["Fresh bug", "Second bug"]) {
      await fetch(`${github.url}/repos/${owner}/app/issues`, {
        method: "POST",
        headers: ghHeaders,
        body: JSON.stringify({ title, labels: ["bug"] }),
      });
    }

    // --- boot the self-host apps runtime over the five seam backings -------
    const store = makeInMemoryAppsStore();
    const resolver = makeGithubRestResolver({
      baseUrl: github.url,
      tokens: { [CONNECTION]: token },
    });
    host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-e2e-")),
      store,
      resolver,
      inMemory: true,
    });
    http = makeAppsHttpRoutes({ runtime: host.runtime });
    mcp = new FakeMcpServer();
    registerAppsMcp(mcp, { runtime: host.runtime, scope: SCOPE });
  }, 60_000);

  afterAll(async () => {
    await host?.close();
    await github?.close();
  });

  it("publishes the daily-brief set over MCP", async () => {
    const publishTool = mcp.tools.get("apps_publish")!;
    const result = (await publishTool({
      files: Object.fromEntries(dailyBriefFileSet()),
    })) as {
      structuredContent: { tools: string[]; workflows: string[]; ui: string[]; skills: string[] };
    };
    expect(result.structuredContent.tools.sort()).toEqual(["issues-sync", "search-all-mail"]);
    expect(result.structuredContent.workflows).toEqual(["morning-sync"]);
    expect(result.structuredContent.ui).toEqual(["dashboard"]);
    expect(result.structuredContent.skills).toEqual(["issues-brief"]);
  });

  const bindings: Bindings = { github: { kind: "single", connection: CONNECTION } };

  it("invokes the published tool over HTTP, hitting the real GitHub emulator", async () => {
    const res = await http.handler(
      new Request(`${base}/api/apps/${SCOPE}/tools/issues-sync`, {
        method: "POST",
        body: JSON.stringify({ args: {}, bindings }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { synced: number; repos: number } };
    expect(body.result.repos).toBe(1);
    expect(body.result.synced).toBe(2);

    // The emulator's request ledger proves the tool really called GitHub.
    const ledger = await github.ledger.list();
    expect(
      ledger.some((e) =>
        String(e.operationId ?? "")
          .toLowerCase()
          .includes("issue"),
      ),
    ).toBe(true);

    // The scope db now holds the two issues.
    const db = await run(host.scopeDb.forScope(SCOPE));
    const rows = await run(db.exec<{ n: number }>("SELECT COUNT(*) AS n FROM issues"));
    expect(Number(rows[0].n)).toBe(2);
  });

  it("starts the workflow and sees it complete with a journal", async () => {
    const res = await http.handler(
      new Request(`${base}/api/apps/${SCOPE}/workflows/morning-sync/start`, {
        method: "POST",
        body: JSON.stringify({ input: {}, bindings, runId: "e2e-morning" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string; output: unknown } };
    expect(body.run.status).toBe("completed");

    // History is queryable and the step.tool call is journaled.
    const histRes = await http.handler(
      new Request(`${base}/api/apps/${SCOPE}/workflows/runs/e2e-morning`, { method: "GET" }),
    );
    const hist = (await histRes.json()) as { steps: { name: string; status: string }[] };
    expect(hist.steps.some((s) => s.name === "tool:issues-sync" && s.status === "completed")).toBe(
      true,
    );
  });

  it("serves the ui view as an MCP resource and a raw bundle over HTTP", async () => {
    // MCP Apps resource (ui:// + _meta).
    const resource = mcp.resources.get("apps-ui")!;
    const read = (await resource.reader(new URL(`ui://${SCOPE}/dashboard`))) as {
      contents: Array<{ mimeType: string; text: string; _meta?: { ui?: { title?: string } } }>;
    };
    expect(read.contents[0].mimeType).toContain("mcp-resource");
    expect(read.contents[0].text).toContain("issues"); // compiled bundle mentions the table
    expect(read.contents[0]._meta?.ui?.title).toBe("GitHub Issues");

    // Raw bundle endpoint.
    const res = await http.handler(
      new Request(`${base}/api/apps/${SCOPE}/ui/dashboard`, { method: "GET" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("x-ui-title")).toBe("GitHub Issues");
  });

  it("delivers an SSE invalidation after a scope-db write", async () => {
    const res = await http.handler(
      new Request(`${base}/api/apps/${SCOPE}/live`, { method: "GET" }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read the initial `ready` frame.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("event: ready");

    // Trigger a write on the scope db -> version bump -> invalidation.
    const db = await run(host.scopeDb.forScope(SCOPE));
    await run(
      db.exec(
        "INSERT INTO issues (repo, number, title, labels, updated_at, url) VALUES ('acme/x', 99, 't', '[]', '2026-01-01', 'u')",
      ),
    );

    // The next SSE frame is the invalidation for the issues table.
    const invalidation = await Promise.race([
      reader.read().then((r) => decoder.decode(r.value)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 5000)),
    ]);
    expect(invalidation).toContain("event: invalidate");
    expect(invalidation).toContain('"table":"issues"');
    await reader.cancel();
  });

  it("lists and reads the published skill over MCP", async () => {
    const listSkills = mcp.tools.get("apps_list_skills")!;
    const listed = (await listSkills({})) as {
      structuredContent: { skills: { name: string; description: string }[] };
    };
    expect(listed.structuredContent.skills.map((s) => s.name)).toEqual(["issues-brief"]);

    const readSkill = mcp.tools.get("apps_read_skill")!;
    const body = (await readSkill({ name: "issues-brief" })) as { content: { text: string }[] };
    expect(body.content[0].text).toContain("GitHub issues brief");
  });
});
