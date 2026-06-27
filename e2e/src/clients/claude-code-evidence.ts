import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { withArtifactLockSync, writeJsonAtomicSync } from "../artifact-io";
import {
  sanitizePublishedText,
  sanitizePublishedUrl,
  sanitizePublishedValue,
} from "../published-artifacts";

export const CLAUDE_CODE_EVIDENCE_FILE = "claude-code-metadata.json";

const REPLAY_API_KEY = "executor-e2e-replay-key";

export interface ClaudeCodeEvidenceInput {
  readonly label: string;
  readonly executable: string;
  readonly expectedVersion: string;
  readonly observedVersion: string | undefined;
  readonly durationMs: number;
  readonly status: "success" | "failure";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly structuredResult?: unknown;
  readonly mcpServerName: string;
  readonly mcpOrigin: string;
  readonly replayOrigin: string;
  readonly replayRequestPaths: ReadonlyArray<string>;
  readonly replayErrors: ReadonlyArray<string>;
  readonly secrets?: ReadonlyArray<string>;
}

export interface ClaudeCodeInvocationEvidence {
  readonly invocationId: string;
  readonly label: string;
  readonly executable: {
    readonly name: string;
    readonly path: string;
  };
  readonly version: {
    readonly expected: string;
    readonly observed: string | null;
  };
  readonly durationMs: number;
  readonly exit: {
    readonly status: "success" | "failure";
    readonly code: number | null;
  };
  readonly output: {
    readonly stdout: string;
    readonly stderr: string;
    readonly structuredResult?: unknown;
  };
  readonly mcp: {
    readonly serverName: string;
    readonly origin: string;
  };
  readonly replay: {
    readonly origin: string;
    readonly requestCount: number;
    readonly requestPaths: ReadonlyArray<string>;
    readonly errors: ReadonlyArray<string>;
  };
  readonly inferenceBoundary: "loopback-replay";
}

export interface ClaudeCodeEvidenceDocument {
  readonly schemaVersion: 1;
  readonly client: "claude-code";
  readonly invocations: ReadonlyArray<ClaudeCodeInvocationEvidence>;
}

const normalizedOrigin = (value: string) => new URL(value).origin;

const loopbackReplayOrigin = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")
  ) {
    throw new Error(`Claude Code evidence requires a loopback replay origin: ${value}`);
  }
  return url.origin;
};

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isInvocationEvidence = (value: unknown): value is ClaudeCodeInvocationEvidence => {
  if (!isUnknownRecord(value)) return false;
  const executable = value.executable;
  const version = value.version;
  const exit = value.exit;
  const output = value.output;
  const mcp = value.mcp;
  const replay = value.replay;
  const validExit =
    isUnknownRecord(exit) &&
    ((exit.status === "success" && exit.code === 0) ||
      (exit.status === "failure" && (typeof exit.code === "number" || exit.code === null)));
  return (
    typeof value.invocationId === "string" &&
    typeof value.label === "string" &&
    isUnknownRecord(executable) &&
    typeof executable.name === "string" &&
    typeof executable.path === "string" &&
    isUnknownRecord(version) &&
    typeof version.expected === "string" &&
    (typeof version.observed === "string" || version.observed === null) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    validExit &&
    isUnknownRecord(output) &&
    typeof output.stdout === "string" &&
    typeof output.stderr === "string" &&
    isUnknownRecord(mcp) &&
    typeof mcp.serverName === "string" &&
    typeof mcp.origin === "string" &&
    isUnknownRecord(replay) &&
    typeof replay.origin === "string" &&
    typeof replay.requestCount === "number" &&
    isStringArray(replay.requestPaths) &&
    replay.requestCount === replay.requestPaths.length &&
    isStringArray(replay.errors) &&
    value.inferenceBoundary === "loopback-replay"
  );
};

const isEvidenceDocument = (value: unknown): value is ClaudeCodeEvidenceDocument =>
  isUnknownRecord(value) &&
  value.schemaVersion === 1 &&
  value.client === "claude-code" &&
  Array.isArray(value.invocations) &&
  value.invocations.every(isInvocationEvidence);

export const readClaudeCodeEvidence = (runDir: string) => {
  const file = join(runDir, CLAUDE_CODE_EVIDENCE_FILE);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isEvidenceDocument(parsed)) {
    throw new Error(`Invalid Claude Code evidence document: ${file}`);
  }
  return parsed;
};

export const makeClaudeCodeInvocationEvidence = (
  input: ClaudeCodeEvidenceInput,
): ClaudeCodeInvocationEvidence => {
  if (input.durationMs < 0 || !Number.isFinite(input.durationMs)) {
    throw new Error(`Claude Code evidence has invalid duration: ${input.durationMs}`);
  }
  if (input.status === "success" && input.exitCode !== 0) {
    throw new Error("Successful Claude Code evidence must have exit code 0");
  }
  if (input.status === "failure" && input.exitCode === 0) {
    throw new Error("Failed Claude Code evidence cannot have exit code 0");
  }

  const sanitization = { secrets: [REPLAY_API_KEY, ...(input.secrets ?? [])] };
  const replayOrigin = loopbackReplayOrigin(input.replayOrigin);
  return {
    invocationId: randomUUID(),
    label: sanitizePublishedText(input.label, sanitization),
    executable: {
      name: sanitizePublishedText(basename(input.executable), sanitization),
      path: sanitizePublishedText(input.executable, sanitization),
    },
    version: {
      expected: sanitizePublishedText(input.expectedVersion, sanitization),
      observed:
        input.observedVersion === undefined
          ? null
          : sanitizePublishedText(input.observedVersion, sanitization),
    },
    durationMs: input.durationMs,
    exit: { status: input.status, code: input.exitCode },
    output: {
      stdout: sanitizePublishedText(input.stdout, sanitization),
      stderr: sanitizePublishedText(input.stderr, sanitization),
      ...(input.structuredResult === undefined
        ? {}
        : { structuredResult: sanitizePublishedValue(input.structuredResult, sanitization) }),
    },
    mcp: {
      serverName: sanitizePublishedText(input.mcpServerName, sanitization),
      origin: sanitizePublishedUrl(normalizedOrigin(input.mcpOrigin), sanitization),
    },
    replay: {
      origin: sanitizePublishedUrl(replayOrigin, sanitization),
      requestCount: input.replayRequestPaths.length,
      requestPaths: input.replayRequestPaths.map((path) =>
        sanitizePublishedText(path, sanitization),
      ),
      errors: input.replayErrors.map((error) => sanitizePublishedText(error, sanitization)),
    },
    inferenceBoundary: "loopback-replay",
  };
};

/**
 * Append one real-client invocation to the attempt's publishable evidence.
 * The replay origin gate and captured request ledger are the proof that the
 * client used deterministic loopback inference instead of a paid provider.
 */
export const writeClaudeCodeEvidence = (runDir: string, input: ClaudeCodeEvidenceInput) => {
  const file = join(runDir, CLAUDE_CODE_EVIDENCE_FILE);
  return withArtifactLockSync(file, () => {
    let existing: ClaudeCodeEvidenceDocument | undefined;
    if (existsSync(file)) {
      existing = readClaudeCodeEvidence(runDir);
    }
    const invocation = makeClaudeCodeInvocationEvidence(input);
    const document: ClaudeCodeEvidenceDocument = {
      schemaVersion: 1,
      client: "claude-code",
      invocations: [...(existing?.invocations ?? []), invocation],
    };
    writeJsonAtomicSync(file, document);
    return invocation;
  });
};
