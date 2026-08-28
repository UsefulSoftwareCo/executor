import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildResumeContentTemplate,
  buildToolPath,
  filterToolPathChildren,
  buildInvokeToolCode,
  buildListIntegrationsCode,
  buildSearchToolsCode,
  extractPausedInteraction,
  extractExecutionId,
  extractExecutionResult,
  inspectToolPath,
  normalizeCliErrorText,
  parseJsonObjectInput,
} from "../apps/cli/src/tooling";

describe("CLI tooling helpers", () => {
  it.effect("parses empty input as an empty args object", () =>
    Effect.gen(function* () {
      const args = yield* parseJsonObjectInput(undefined);
      expect(args).toEqual({});
    }),
  );

  it.effect("parses JSON object input", () =>
    Effect.gen(function* () {
      const args = yield* parseJsonObjectInput('{"calendarId":"primary"}');
      expect(args).toEqual({ calendarId: "primary" });
    }),
  );

  it.effect("rejects non-object JSON input", () =>
    Effect.gen(function* () {
      const error = yield* parseJsonObjectInput("[1,2,3]").pipe(Effect.flip);
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: helper contract returns a native Error for CLI input parsing
      expect(error.message).toContain("must decode to a JSON object");
    }),
  );

  it("builds bracket-safe invocation code for dynamic tool paths", () => {
    const code = buildInvokeToolCode("google-drive.files.list", { pageSize: 10 });
    expect(code).toContain('const __target = tools["google-drive"]["files"]["list"]');
    expect(code).toContain("const __args = {");
  });

  it("builds tool paths from dot or segmented forms", () => {
    expect(buildToolPath(["github", "issues", "create"])).toBe("github.issues.create");
    expect(buildToolPath(["github.issues", "create"])).toBe("github.issues.create");
  });

  it("rejects invalid tool-path segments", () => {
    expect(() => buildToolPath(["github", "issues", "create now"])).toThrow();
  });

  it("builds search and integrations code snippets", () => {
    const searchCode = buildSearchToolsCode({
      query: "google calendar events",
      namespace: "google",
      limit: 5,
    });
    const integrationsCode = buildListIntegrationsCode({ query: "google", limit: 20 });

    expect(searchCode).toBe(
      'return await tools.search({"query":"google calendar events","limit":5,"namespace":"google"});',
    );
    expect(integrationsCode).toBe(
      'return await tools.executor.integrations.list({"limit":20,"query":"google"});',
    );
  });

  it("extracts completed result payload and pause execution id", () => {
    expect(extractExecutionResult({ status: "completed", result: { ok: true }, logs: [] })).toEqual(
      {
        ok: true,
      },
    );
    expect(extractExecutionResult({ status: "completed" })).toBeNull();

    expect(extractExecutionId({ executionId: "exec_123" })).toBe("exec_123");
    expect(extractExecutionId({ executionId: 123 })).toBeUndefined();
  });

  it("inspects hierarchical tool path prefixes for call help", () => {
    const view = inspectToolPath({
      toolPaths: [
        "cloudflare.dns.records.list",
        "cloudflare.dns.records.create",
        "cloudflare.dns.analytics",
        "cloudflare.zones.list",
      ],
      rawPrefixParts: ["cloudflare", "dns"],
    });

    expect(view.prefixSegments).toEqual(["cloudflare", "dns"]);
    expect(view.exactPath).toBeUndefined();
    expect(view.matchingToolCount).toBe(3);
    expect(view.children).toEqual([
      { segment: "analytics", invokable: true, hasChildren: false, toolCount: 1 },
      { segment: "records", invokable: false, hasChildren: true, toolCount: 2 },
    ]);
  });

  it("reports exact matches for leaf tool paths", () => {
    const view = inspectToolPath({
      toolPaths: ["github.issues.create", "github.issues.list"],
      rawPrefixParts: ["github", "issues", "create"],
    });

    expect(view.prefixSegments).toEqual(["github", "issues", "create"]);
    expect(view.exactPath).toBe("github.issues.create");
    expect(view.matchingToolCount).toBe(1);
    expect(view.children).toEqual([]);
  });

  it("extracts paused form interaction payload", () => {
    const interaction = extractPausedInteraction({
      status: "waiting_for_interaction",
      executionId: "exec_1",
      interaction: {
        kind: "form",
        message: "Need approval",
        requestedSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
          },
          required: ["approved"],
        },
      },
    });

    expect(interaction).toEqual({
      kind: "form",
      message: "Need approval",
      requestedSchema: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
        },
        required: ["approved"],
      },
    });
  });

  it("builds resume content template from requested schema", () => {
    const template = buildResumeContentTemplate({
      type: "object",
      properties: {
        approved: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["approved"],
    });

    expect(template).toEqual({ approved: false });
  });

  it("filters child segments with singular/plural matching", () => {
    const children = [
      { segment: "zoneRulesets", invokable: false, hasChildren: true, toolCount: 10 },
      { segment: "dnsRecordsForAZone", invokable: false, hasChildren: true, toolCount: 14 },
      { segment: "workersAi", invokable: false, hasChildren: true, toolCount: 8 },
    ] as const;

    expect(filterToolPathChildren(children, "zones").map((entry) => entry.segment)).toEqual([
      "zoneRulesets",
      "dnsRecordsForAZone",
    ]);
    expect(filterToolPathChildren(children, "worker").map((entry) => entry.segment)).toEqual([
      "workersAi",
    ]);
  });

  it("normalizes stack-heavy CLI error text", () => {
    const normalized = normalizeCliErrorText(`Error: Error: TypeError: bad
      at fn1 (/tmp/a.ts:1:1)
      at fn2 (/tmp/b.ts:2:2)
From previous event:
      at fn3 (/tmp/c.ts:3:3)`);

    expect(normalized).toBe("TypeError: bad");
  });
});
