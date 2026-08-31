// Cross-target: the MCP surface — connect with fully headless OAuth (DCR →
// consent → code → token) and run code in the sandbox, exactly as an MCP
// client (Claude, Cursor, …) would.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

/** The raw MCP tool result shape the fidelity scenarios assert against. */
const rawResultOf = (result: { readonly raw: unknown }) =>
  result.raw as {
    content?: ReadonlyArray<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };

scenario(
  "MCP · OAuth connect, then execute code in the sandbox",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    const tools = yield* session.listTools();
    expect(tools, "the execute tool is advertised").toContain("execute");

    const result = yield* session.call("execute", { code: "return 6 * 7;" });
    expect(result.text, "the sandbox returns the value").toBe("42");
  }),
);

// The exact value a sandbox script returns, non-ASCII included. The server
// renders it into the text channel (pretty-printed JSON) and mirrors it into
// `structuredContent`; both must reach the client byte-identical — a client
// diffing retries or hashing results must never see the payload drift.
const structuredPayload = {
  greeting: "héllo — こんにちは ✅",
  emoji: "🚀",
  values: [1, 2, 3],
  nested: { ok: true, label: "Zoë" },
};

scenario(
  "MCP · a structured return value reaches the client byte-identical in text and structuredContent",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);
    yield* session.listTools();

    const result = yield* session.call("execute", {
      code: `return ${JSON.stringify(structuredPayload)};`,
    });
    expect(result.ok, "the sandbox run completes without error").toBe(true);

    const expectedText = JSON.stringify(structuredPayload, null, 2);
    const raw = rawResultOf(result);
    expect(raw.content?.length, "the result arrives as a single text block").toBe(1);
    expect(raw.content?.[0]?.text, "the text channel carries the exact rendered value").toBe(
      expectedText,
    );
    expect(result.text, "the joined text content matches byte-for-byte").toBe(expectedText);
    expect(raw.structuredContent, "structuredContent mirrors the exact returned value").toEqual({
      status: "completed",
      result: structuredPayload,
      logs: [],
    });
  }),
);

/** Sandbox code that runs ONE approval-gated call (the `policies.create` core
 *  tool gates itself via its `requiresApproval` annotation — same hermetic
 *  device as policy-tool-approval.test.ts) and then returns a deterministic
 *  payload. The pattern is unique-per-run and matches no real tool, so the
 *  created `block` rule is inert even if leaked. */
const gatedThenReturnCode = (pattern: string, payload: unknown) => `
await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(pattern)},
  action: "block",
});
return ${JSON.stringify(payload)};
`;

scenario(
  "MCP · a duplicate resume replays the identical settled result without re-running the tool",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);
    const pattern = `mcp-resume-replay-${randomUUID().slice(0, 8)}.*`;
    const replayPayload = { note: "resumed — résultat 完了 ✅", pattern };

    const cleanup = client.policies.list().pipe(
      Effect.flatMap((list) =>
        Effect.forEach(
          list.filter((p) => p.pattern === pattern),
          (p) =>
            client.policies
              .remove({ params: { policyId: p.id }, payload: { owner: "user" } })
              .pipe(Effect.ignore),
        ),
      ),
      Effect.ignore,
    );

    yield* Effect.gen(function* () {
      const session = mcp.session(identity);
      yield* session.listTools();

      const paused = yield* session.call("execute", {
        code: gatedThenReturnCode(pattern, replayPayload),
      });
      expect(paused.text, "the gated call pauses for approval").toContain("Execution paused");
      const match = /\bexecutionId:\s*(\S+)/.exec(paused.text);
      expect(match, "the pause carries an executionId to resume").not.toBeNull();

      // MCP clients retry `resume` when a response is lost in transit, so the
      // duplicate uses the exact same arguments as the first delivery.
      const resumeArgs = {
        executionId: match![1]!,
        action: "accept",
        content: JSON.stringify({}),
      };

      const resumed = yield* session.call("resume", resumeArgs);
      expect(resumed.ok, "the approved execution completes without error").toBe(true);
      const expectedText = JSON.stringify(replayPayload, null, 2);
      expect(resumed.text, "the resumed result carries the exact returned value").toBe(
        expectedText,
      );
      expect(
        rawResultOf(resumed).structuredContent,
        "the resumed structuredContent mirrors the exact returned value",
      ).toEqual({ status: "completed", result: replayPayload, logs: [] });

      const replayed = yield* session.call("resume", resumeArgs);
      expect(replayed.ok, "the duplicate resume succeeds instead of erroring").toBe(true);
      expect(replayed.text, "the replayed text is byte-identical to the first delivery").toBe(
        resumed.text,
      );
      expect(
        rawResultOf(replayed).structuredContent,
        "the replayed structuredContent is identical to the first delivery",
      ).toEqual(rawResultOf(resumed).structuredContent);

      // The replay served the recorded outcome — the gated tool did not run a
      // second time.
      const afterReplay = yield* client.policies.list();
      expect(
        afterReplay.filter((p) => p.pattern === pattern).length,
        "the gated tool ran exactly once despite the duplicate resume",
      ).toBe(1);
    }).pipe(Effect.ensuring(cleanup));
  }),
);

scenario(
  "MCP · a syntax error returns a descriptive message, not an opaque internal error",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    // A genuine parse error (a `const` with no binding) is the user's own
    // mistake, surfaced before the code ever runs. The model needs the real
    // reason to self-correct, so the sandbox must report it descriptively
    // instead of collapsing it to "Internal tool error [id]".
    const result = yield* session.call("execute", {
      code: "const = 5; return 1;",
    });

    expect(result.ok, "a syntax error is reported as an error result").toBe(false);
    expect(result.text, "the parser's reason reaches the model").toContain("Unexpected");
    expect(result.text, "the opaque mask is not used for syntax errors").not.toContain(
      "Internal tool error",
    );
  }),
);
