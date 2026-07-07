import { describe, expect, it } from "@effect/vitest";

import appsClientPlugin, {
  CUSTOM_TOOLS_LABEL,
  CUSTOM_TOOLS_PLUGIN_KEY,
  type CustomToolsFetch,
  appsIntegrationPlugin,
  formatSyncErrors,
  getCustomToolSource,
  listCustomToolSources,
  removeCustomToolSource,
  parseGitHubSourceUrl,
  slugifyCustomToolsAppName,
  suggestCustomToolsAppName,
  syncCustomToolSource,
  syncStatusLabel,
  validateGitHubSourceUrl,
} from "./plugin-client";

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("custom tools console client", () => {
  it("registers the manual Custom tools tile", () => {
    const manualTiles = [appsIntegrationPlugin].map((plugin) => ({
      href: `/integrations/add/${plugin.key}`,
      label: plugin.label,
    }));

    expect(appsClientPlugin.id).toBe(CUSTOM_TOOLS_PLUGIN_KEY);
    expect(appsClientPlugin.integrationPlugin?.label).toBe(CUSTOM_TOOLS_LABEL);
    expect(manualTiles).toContainEqual({
      href: "/integrations/add/apps",
      label: "Custom tools",
    });
  });

  it("validates the GitHub URL shape", () => {
    expect(validateGitHubSourceUrl("https://github.com/UsefulSoftwareCo/executor")).toBeNull();
    expect(validateGitHubSourceUrl("UsefulSoftwareCo/executor")).toBeNull();
    expect(validateGitHubSourceUrl("https://gitlab.com/UsefulSoftwareCo/executor")).toBe(
      "GitHub source URLs must use github.com.",
    );
    expect(validateGitHubSourceUrl("UsefulSoftwareCo")).toBe(
      "Use a GitHub repo URL like https://github.com/owner/repo, optionally with /tree/<ref> or /commit/<sha>.",
    );
    expect(validateGitHubSourceUrl("")).toBe("Enter a GitHub URL.");
  });

  it("carries detected repo URL variants into the add form defaults", () => {
    const treeUrl =
      "https://github.com/RhysSullivan/executor-custom-tools-demo/tree/feature/custom-tools";
    const commitUrl = "https://github.com/RhysSullivan/executor-custom-tools-demo/commit/abc1234";

    const tree = parseGitHubSourceUrl(treeUrl);
    const commit = parseGitHubSourceUrl(commitUrl);

    expect(tree).toMatchObject({
      ok: true,
      value: {
        repo: "RhysSullivan/executor-custom-tools-demo",
        ref: "feature/custom-tools",
        url: treeUrl,
      },
    });
    expect(commit).toMatchObject({
      ok: true,
      value: {
        repo: "RhysSullivan/executor-custom-tools-demo",
        ref: "abc1234",
        url: commitUrl,
      },
    });
    expect(suggestCustomToolsAppName(treeUrl)).toBe("executor-custom-tools-demo");
    expect(slugifyCustomToolsAppName(suggestCustomToolsAppName(treeUrl))).toBe(
      "executor-custom-tools-demo",
    );
  });

  it("does not classify non-repo GitHub URLs as custom-tools add input", () => {
    expect(parseGitHubSourceUrl("https://gist.github.com/RhysSullivan/abc1234").ok).toBe(false);
    expect(
      parseGitHubSourceUrl(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/blob/main/openapi.json",
      ).ok,
    ).toBe(false);
  });

  it("surfaces successful sync and source detail data", async () => {
    let syncBody = "";
    let removed = false;
    const fetchImpl: CustomToolsFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sync")) {
        syncBody = String(init?.body ?? "");
        return jsonResponse({
          status: "published",
          snapshotId: "snap1",
          upstreamSha: "abc123",
          tools: ["repo-summary", "stale-issues"],
          skipped: [],
        });
      }
      if (url.endsWith("/demo-tools")) {
        if (init?.method === "DELETE") {
          removed = true;
          return jsonResponse({ removed: true });
        }
        return jsonResponse({
          source: {
            slug: "demo-tools",
            name: "demo-tools",
            scope: "demo-tools",
            url: "https://github.com/RhysSullivan/executor-custom-tools-demo",
            repo: "RhysSullivan/executor-custom-tools-demo",
            ref: "main",
            hasToken: true,
            upstreamSha: "abc123",
            snapshotId: "snap1",
            publishedAt: "2026-07-06T12:00:00.000Z",
            tools: ["repo-summary", "stale-issues"],
            skipped: [],
          },
        });
      }
      return jsonResponse({
        sources: [
          {
            slug: "demo-tools",
            name: "demo-tools",
            scope: "demo-tools",
            url: "https://github.com/RhysSullivan/executor-custom-tools-demo",
            repo: "RhysSullivan/executor-custom-tools-demo",
            ref: "main",
            hasToken: true,
            upstreamSha: "abc123",
            snapshotId: "snap1",
            publishedAt: "2026-07-06T12:00:00.000Z",
            tools: ["repo-summary", "stale-issues"],
            skipped: [],
          },
        ],
      });
    };

    const syncResult = await syncCustomToolSource(
      {
        name: "demo-tools",
        url: "https://github.com/RhysSullivan/executor-custom-tools-demo",
        token: "ghp_demo",
      },
      fetchImpl,
    );
    const listed = await listCustomToolSources(fetchImpl);
    const detail = await getCustomToolSource("demo-tools", fetchImpl);
    const remove = await removeCustomToolSource("demo-tools", fetchImpl);

    expect(syncStatusLabel(syncResult)).toBe("Published 2 tools.");
    expect(syncBody).toContain("ghp_demo");
    expect(syncBody).toContain("demo-tools");
    expect(syncResult.tools).toEqual(["repo-summary", "stale-issues"]);
    expect(detail.source?.slug).toBe("demo-tools");
    expect(listed.sources[0]?.hasToken).toBe(true);
    expect(listed.sources[0]?.tools).toEqual(["repo-summary", "stale-issues"]);
    expect(remove).toEqual({ removed: true });
    expect(removed).toBe(true);
  });

  it("renders failed sync errors readably", async () => {
    const fetchImpl: CustomToolsFetch = async () =>
      jsonResponse({
        status: "failed",
        tools: [],
        skipped: [],
        errors: [
          {
            stage: "collect",
            message: "schema library not supported for schema export",
            diagnostics: [{ path: "tools/x.ts", message: "vendor: nope" }],
          },
        ],
      });

    const result = await syncCustomToolSource(
      {
        url: "https://github.com/RhysSullivan/executor-custom-tools-demo",
      },
      fetchImpl,
    );

    expect(syncStatusLabel(result)).toBe("Sync failed.");
    expect(formatSyncErrors(result)).toEqual([
      "collect: schema library not supported for schema export (tools/x.ts: vendor: nope)",
    ]);
  });

  it("shows the up-to-date sync state", async () => {
    const fetchImpl: CustomToolsFetch = async () =>
      jsonResponse({
        status: "up-to-date",
        upstreamSha: "abc123",
        tools: ["repo-summary"],
        skipped: [],
      });

    const result = await syncCustomToolSource(
      {
        url: "https://github.com/RhysSullivan/executor-custom-tools-demo",
      },
      fetchImpl,
    );

    expect(syncStatusLabel(result)).toBe("Already up to date.");
  });
});
