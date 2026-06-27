import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { EvidencePublicationMetadata } from "../src/published-artifacts";
import { buildManifest } from "../src/viewer/manifest";
import { ArtifactNavigation, runRoute } from "../viewer/src/App";
import PortableTraceExplorer from "../viewer/src/PortableTraceExplorer";
import PublicationBanner, { parsePublicationMetadata } from "../viewer/src/PublicationBanner";
import {
  liveMotelViewerFromSearch,
  parsePortableTraceExport,
  waterfallPosition,
  type PortableTraceExport,
} from "../viewer/src/portable-traces";

const traceId = "0123456789abcdef0123456789abcdef";
const portableExport: PortableTraceExport = {
  schemaVersion: 1,
  exportedAt: 1_751_000_000_000,
  traces: [
    {
      traceId,
      data: {
        traceId,
        serviceName: "executor-cloud",
        rootOperationName: "POST /api/tools/call",
        startedAt: "2026-06-26T00:00:00.000Z",
        isRunning: false,
        durationMs: 100,
        spanCount: 2,
        errorCount: 0,
        warnings: [],
        spans: [
          {
            spanId: "root-span",
            parentSpanId: null,
            serviceName: "executor-cloud",
            scopeName: "executor.http",
            kind: "server",
            operationName: "POST /api/tools/call",
            startTime: "2026-06-26T00:00:00.000Z",
            isRunning: false,
            durationMs: 100,
            status: "ok",
            depth: 0,
            tags: { "http.response.status_code": "200", "db.system": "sqlite" },
            warnings: [],
            events: [
              {
                name: "cache.miss",
                timestamp: "2026-06-26T00:00:00.010Z",
                attributes: { key: "profile" },
              },
            ],
          },
          {
            spanId: "child-span",
            parentSpanId: "root-span",
            serviceName: "executor-storage",
            scopeName: null,
            kind: "internal",
            operationName: "load active account",
            startTime: "2026-06-26T00:00:00.025Z",
            isRunning: false,
            durationMs: 50,
            status: "ok",
            depth: 1,
            tags: {},
            warnings: [],
            events: [],
          },
        ],
      },
    },
  ],
  missing: [],
  invalidTraceIds: [],
};

describe("portable trace viewer", () => {
  it("parses persisted traces and computes a stable span waterfall", () => {
    expect(parsePortableTraceExport(portableExport)).toEqual(portableExport);

    const trace = portableExport.traces[0].data;
    expect(waterfallPosition(trace, trace.spans[0])).toEqual({ left: 0, width: 100 });
    expect(waterfallPosition(trace, trace.spans[1])).toEqual({ left: 25, width: 50 });
  });

  it("renders useful trace and span detail without a live telemetry service", () => {
    const html = renderToStaticMarkup(
      createElement(PortableTraceExplorer, {
        exportData: portableExport,
        ledger: [{ id: traceId, url: "http://127.0.0.1/api/tools/call" }],
        onSelectTrace: () => undefined,
      }),
    );

    expect(html).toContain("POST /api/tools/call");
    expect(html).toContain("load active account");
    expect(html).toContain("db.system");
    expect(html).toContain("cache.miss");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("aria-selected");
    expect(html).toContain("Trace /api/tools/call, 100ms, 2 spans");
    expect(html).toContain("POST /api/tools/call, executor-cloud, 100ms, ok");
    expect(html).not.toContain("open live Motel");
  });

  it("uses canonical run routes and exposes persisted evidence files directly", () => {
    expect(runRoute("desktop-kvm", "2026-06-27T00-00-00-000Z-1234")).toBe(
      "#/run/desktop-kvm/2026-06-27T00-00-00-000Z-1234",
    );
    const html = renderToStaticMarkup(
      createElement(ArtifactNavigation, {
        base: "desktop-kvm/run-123",
        artifacts: [
          { name: "claude-code-metadata.json", kind: "json", label: "Claude code metadata" },
          { name: "anthropic-replay-ledger.json", kind: "json", label: "Anthropic replay ledger" },
          { name: "packaged-app.log", kind: "text", label: "packaged app" },
        ],
      }),
    );
    expect(html).toContain("Persisted evidence");
    expect(html).toContain("desktop-kvm/run-123/claude-code-metadata.json");
    expect(html).toContain("desktop-kvm/run-123/anthropic-replay-ledger.json");
    expect(html).toContain("desktop-kvm/run-123/packaged-app.log");
  });

  it("accepts only explicit loopback live Motel enhancements", () => {
    expect(liveMotelViewerFromSearch("?motel=http%3A%2F%2F127.0.0.1%3A61234%2F")).toBe(
      "http://127.0.0.1:61234",
    );
    expect(liveMotelViewerFromSearch("?motel=https%3A%2F%2Ftelemetry.example.com")).toBeUndefined();
    expect(liveMotelViewerFromSearch("?motel=javascript%3Aalert(1)")).toBeUndefined();
  });
});

describe("publication provenance banner", () => {
  const metadata: EvidencePublicationMetadata = {
    schemaVersion: 1,
    sanitizedAt: 1_751_000_000_000,
    status: "passed",
    sanitizer: {
      source: "e2e/scripts/sanitize-evidence.ts",
      policyVersion: 1,
      sourceRevision: "abc123",
    },
    policy: {
      unknownArtifacts: "removed",
      textAndJson: "redacted",
      binaryVisuals: "unredacted-synthetic-only",
      binarySecretDetection: "byte-canary-only",
    },
    runtime: { name: "bun", version: "1.3.0", platform: "linux", arch: "x64" },
    stats: { removed: 4, redacted: 8, retained: 3, canariesChecked: 2 },
    binaryArtifacts: ["desktop/example/01-proof.png"],
    errors: [],
  };

  it("parses persisted sanitizer provenance and explains the binary limitation", () => {
    expect(parsePublicationMetadata(metadata)).toEqual(metadata);
    expect(parsePublicationMetadata({ ...metadata, schemaVersion: 2 })).toBeNull();

    const sanitized = renderToStaticMarkup(createElement(PublicationBanner, { metadata }));
    expect(sanitized).toContain("Sanitized evidence publication");
    expect(sanitized).toContain("remain unredacted under the synthetic-only policy");
    expect(sanitized).toContain("Byte canaries checked: 2");

    const local = renderToStaticMarkup(createElement(PublicationBanner, { metadata: null }));
    expect(local).toContain("Do not publish this directory");
  });
});

describe("portable trace manifest", () => {
  it.effect("indexes portable trace completeness for each attempt", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-viewer-manifest-"))),
      (runsDir) =>
        Effect.sync(() => {
          const runDir = join(runsDir, "cloud", "account-switch--attempt-123");
          mkdirSync(runDir, { recursive: true });
          writeFileSync(
            join(runDir, "result.json"),
            JSON.stringify({
              scenario: "Account switching",
              target: "cloud",
              attemptId: "attempt-123",
              ok: true,
              durationMs: 1234,
              endedAt: 1_751_000_000_000,
              portableTraces: { exported: 2, missing: 1 },
            }),
          );
          writeFileSync(join(runDir, "claude-code-metadata.json"), "{}");
          writeFileSync(join(runDir, "anthropic-replay-ledger.json"), "{}");
          writeFileSync(join(runDir, "account-fixture-ledger.json"), "{}");
          writeFileSync(join(runDir, "packaged-app.log"), "synthetic log");
          writeFileSync(join(runDir, "mcporter.json"), "{}");

          buildManifest(runsDir);

          expect(JSON.parse(readFileSync(join(runsDir, "manifest.json"), "utf8"))).toMatchObject({
            runs: [
              {
                scenario: "Account switching",
                target: "cloud",
                slug: "account-switch--attempt-123",
                attemptId: "attempt-123",
                portableTraceCount: 2,
                portableTraceMissing: 1,
                artifacts: [
                  {
                    name: "account-fixture-ledger.json",
                    kind: "json",
                    label: "account fixture ledger",
                  },
                  {
                    name: "anthropic-replay-ledger.json",
                    kind: "json",
                    label: "anthropic replay ledger",
                  },
                  {
                    name: "claude-code-metadata.json",
                    kind: "json",
                    label: "Claude code metadata",
                  },
                  { name: "packaged-app.log", kind: "text", label: "packaged app" },
                  { name: "result.json", kind: "json", label: "result" },
                ],
              },
            ],
          });
        }),
      (runsDir) => Effect.sync(() => rmSync(runsDir, { recursive: true, force: true })),
    ),
  );
});
