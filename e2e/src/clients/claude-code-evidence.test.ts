import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { publishedArtifactFor } from "../published-artifacts";
import {
  CLAUDE_CODE_EVIDENCE_FILE,
  makeClaudeCodeInvocationEvidence,
  readClaudeCodeEvidence,
  writeClaudeCodeEvidence,
} from "./claude-code-evidence";

const evidenceInput = (label: string, marker: string) => ({
  label,
  executable: "/home/alice/.local/bin/claude",
  expectedVersion: "2.1.195",
  observedVersion: "2.1.195",
  durationMs: 321,
  status: "success" as const,
  exitCode: 0,
  stdout: `result=${marker} authorization: Bearer account-secret`,
  stderr: "api_key=executor-e2e-replay-key",
  structuredResult: {
    marker,
    authorization: "Bearer account-secret",
  },
  mcpServerName: "executor",
  mcpOrigin: "https://executor.example.test/mcp?token=account-secret",
  replayOrigin: "http://127.0.0.1:43123",
  replayRequestPaths: ["/v1/messages?token=account-secret", "/v1/messages"],
  replayErrors: [] as ReadonlyArray<string>,
  secrets: ["account-secret"],
});

it.effect("writes ordered, sanitized Claude Code invocation evidence for an account switch", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-claude-evidence-"))),
    (runDir) =>
      Effect.sync(() => {
        writeClaudeCodeEvidence(runDir, evidenceInput("account-a-before-switch", "account-a"));
        writeClaudeCodeEvidence(runDir, evidenceInput("account-b-after-switch", "account-b"));

        const serialized = readFileSync(join(runDir, CLAUDE_CODE_EVIDENCE_FILE), "utf8");
        const document = readClaudeCodeEvidence(runDir);
        expect(document.schemaVersion).toBe(1);
        expect(document.client).toBe("claude-code");
        expect(publishedArtifactFor(`cloud/example-run/${CLAUDE_CODE_EVIDENCE_FILE}`)).toEqual({
          kind: "json",
          mime: "application/json; charset=utf-8",
        });
        expect(document.invocations.map((entry) => entry.label)).toEqual([
          "account-a-before-switch",
          "account-b-after-switch",
        ]);
        expect(document.invocations.map((entry) => entry.output.structuredResult)).toEqual([
          { marker: "account-a", authorization: "[REDACTED]" },
          { marker: "account-b", authorization: "[REDACTED]" },
        ]);
        expect(document.invocations[0]?.executable).toEqual({
          name: "claude",
          path: "/home/[USER]/.local/bin/claude",
        });
        expect(document.invocations[0]?.replay).toEqual({
          origin: "http://127.0.0.1:43123/",
          requestCount: 2,
          requestPaths: ["/v1/messages?token=[REDACTED]", "/v1/messages"],
          errors: [],
        });
        expect(document.invocations.map((entry) => entry.exit)).toEqual([
          { status: "success", code: 0 },
          { status: "success", code: 0 },
        ]);
        expect(document.invocations.map((entry) => entry.durationMs)).toEqual([321, 321]);
        expect(document.invocations.map((entry) => entry.inferenceBoundary)).toEqual([
          "loopback-replay",
          "loopback-replay",
        ]);
        expect(serialized).not.toContain("account-secret");
        expect(serialized).not.toContain("executor-e2e-replay-key");
        expect(serialized).not.toContain("/home/alice");
      }),
    (runDir) => Effect.sync(() => rmSync(runDir, { recursive: true, force: true })),
  ),
);

it("rejects non-loopback inference evidence", () => {
  expect(() =>
    makeClaudeCodeInvocationEvidence({
      ...evidenceInput("paid-boundary", "should-not-write"),
      replayOrigin: "https://api.anthropic.com",
    }),
  ).toThrow("requires a loopback replay origin");
});
