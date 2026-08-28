import { expect, test } from "@effect/vitest";

import {
  containsContentHash,
  stableGroupingFingerprint,
  stripContentHashes,
  withStableGroupingFingerprint,
  type GroupingEvent,
} from "./sentry-grouping";

// Two builds of the same source: only the Vite content hash differs.
const workerFrame = (hash: string) => ({
  filename: `/assets/execution-rate-limit-${hash}.js`,
  module: `execution-rate-limit-${hash}`,
  function: "timeoutOrElse",
  in_app: true,
});

const workerEvent = (hash: string): GroupingEvent => ({
  culprit: `timeoutOrElse(execution-rate-limit-${hash})`,
  exception: {
    values: [
      {
        type: "GateCheckTimeoutError",
        value: "balance check timed out",
        stacktrace: { frames: [workerFrame(hash)] },
      },
    ],
  },
});

test("stripContentHashes rewrites chunk hashes and leaves everything else alone", () => {
  expect(stripContentHashes("/assets/execution-rate-limit-BAuwphPA.js")).toBe(
    "/assets/execution-rate-limit.js",
  );
  expect(stripContentHashes("/assets/execution-rate-limit-DkcPBbWe.js")).toBe(
    "/assets/execution-rate-limit.js",
  );
  // Rollup hashes may themselves contain a dash — the whole 8-char tail goes.
  expect(stripContentHashes("http://127.0.0.1:4789/assets/AddGraphqlIntegration-BCr-oWx4.js")).toBe(
    "http://127.0.0.1:4789/assets/AddGraphqlIntegration.js",
  );
  // Culprit strings wrap the chunk name in parentheses.
  expect(stripContentHashes("U(assets/atoms-Yemn7yhP)")).toBe("U(assets/atoms)");
  expect(stripContentHashes("W(assets/atoms-CeCENfWa)")).toBe("W(assets/atoms)");
});

test("stripContentHashes does not eat real name segments", () => {
  // 8 lowercase letters is a word, not a hash.
  expect(stripContentHashes("/src/auth/oauth-callback.ts")).toBe("/src/auth/oauth-callback.ts");
  expect(stripContentHashes("apps/cloud/src/engine/execution-gate.ts")).toBe(
    "apps/cloud/src/engine/execution-gate.ts",
  );
  expect(stripContentHashes("/assets/execution-rate-limit.js")).toBe(
    "/assets/execution-rate-limit.js",
  );
  expect(stripContentHashes("")).toBe("");
});

test("stripContentHashes keeps genuinely different modules distinct", () => {
  expect(stripContentHashes("/assets/atoms-Yemn7yhP.js")).not.toBe(
    stripContentHashes("/assets/router-CeCENfWa.js"),
  );
  expect(stripContentHashes("/assets/atoms-Yemn7yhP.js")).not.toBe(
    stripContentHashes("/assets/atoms-shell-CeCENfWa.js"),
  );
});

// Merging two unrelated bugs into one issue is unrecoverable, so the "is this
// a hash?" threshold is pinned from both sides: a segment needs two of the
// three hash signals (uppercase, uppercase+digit, digits) before it is eaten.
// Loosening it to one signal — the tempting fix for the word-shaped hashes
// this deliberately misses — silently collapses real chunk names.
test("a name segment one signal short of a hash is left in place", () => {
  // One capital, no digits.
  expect(stripContentHashes("/assets/connections-Settings.js")).toBe(
    "/assets/connections-Settings.js",
  );
  // One digit, no capitals.
  expect(stripContentHashes("/assets/storage-s3client.js")).toBe("/assets/storage-s3client.js");
  // ...and neither may be mistaken for the chunk it would collapse onto.
  expect(stripContentHashes("/assets/connections-Settings.js")).not.toBe(
    stripContentHashes("/assets/connections-BAuwphPA.js"),
  );
});

test("a segment with two hash signals is eaten", () => {
  expect(stripContentHashes("/assets/chunk-AbcdefgH.js")).toBe("/assets/chunk.js");
  expect(stripContentHashes("/assets/chunk-Abcdefg1.js")).toBe("/assets/chunk.js");
  expect(stripContentHashes("/assets/chunk-abcdef12.js")).toBe("/assets/chunk.js");
});

test("containsContentHash detects only hashed paths", () => {
  expect(containsContentHash("/assets/atoms-Yemn7yhP.js")).toBe(true);
  expect(containsContentHash("apps/cloud/src/engine/execution-gate.ts")).toBe(false);
});

test("the same logical frame fingerprints identically across two deploys", () => {
  const first = stableGroupingFingerprint(workerEvent("BAuwphPA"));
  const second = stableGroupingFingerprint(workerEvent("DkcPBbWe"));
  expect(first).toBeDefined();
  expect(first).toEqual(second);
  expect(first).toEqual(["GateCheckTimeoutError", "timeoutOrElse@execution-rate-limit"]);
});

test("different modules keep different fingerprints", () => {
  const other: GroupingEvent = {
    exception: {
      values: [
        {
          type: "GateCheckTimeoutError",
          stacktrace: {
            frames: [
              {
                filename: "/assets/atoms-Yemn7yhP.js",
                module: "atoms-Yemn7yhP",
                function: "loadConnections",
                in_app: true,
              },
            ],
          },
        },
      ],
    },
  };
  expect(stableGroupingFingerprint(other)).not.toEqual(
    stableGroupingFingerprint(workerEvent("BAuwphPA")),
  );
});

test("minified single-letter frame functions are left out of the fingerprint", () => {
  // Minified identifiers rotate with every build exactly like chunk hashes, so
  // keeping them would re-split the issue on the next deploy.
  const atoms = (fn: string, hash: string): GroupingEvent => ({
    exception: {
      values: [
        {
          type: "TypeError",
          stacktrace: {
            frames: [
              { filename: `/assets/atoms-${hash}.js`, module: `atoms-${hash}`, function: fn },
            ],
          },
        },
      ],
    },
  });
  expect(stableGroupingFingerprint(atoms("U", "Yemn7yhP"))).toEqual(
    stableGroupingFingerprint(atoms("W", "CeCENfWa")),
  );
  expect(stableGroupingFingerprint(atoms("U", "Yemn7yhP"))).toEqual(["TypeError", "atoms"]);
});

// A single build emits many `dist-<hash>.js` chunks from unrelated packages,
// so the crashing frame alone is not a safe key — two different bugs would
// land in one issue. Frames are oldest-first, so the shared chunk is last.
const vendorEvent = (caller: string, hash: string): GroupingEvent => ({
  exception: {
    values: [
      {
        type: "TypeError",
        stacktrace: {
          frames: [
            { module: `${caller}-${hash}`, function: caller, in_app: true },
            { module: `dist-${hash}`, function: "throwHelper", in_app: true },
          ],
        },
      },
    ],
  },
});

test("two vendor chunks sharing a name stay apart on their callers", () => {
  const upload = stableGroupingFingerprint(vendorEvent("uploadArtifact", "BQZkXWT2"));
  const render = stableGroupingFingerprint(vendorEvent("renderMarkdown", "BQZkXWT2"));

  // The crashing frame is identical in both — only the caller chain separates
  // them, so a fingerprint built from the top frame alone would over-merge.
  expect(upload?.slice(0, 2)).toEqual(["TypeError", "throwHelper@dist"]);
  expect(render?.slice(0, 2)).toEqual(upload?.slice(0, 2));
  expect(upload).not.toEqual(render);
  expect(upload).toEqual(["TypeError", "throwHelper@dist", "uploadArtifact@uploadArtifact"]);
});

test("the caller chain is itself deploy-stable", () => {
  // Every frame in the chain must lose its hash, not just the crashing one.
  expect(stableGroupingFingerprint(vendorEvent("uploadArtifact", "BQZkXWT2"))).toEqual(
    stableGroupingFingerprint(vendorEvent("uploadArtifact", "Yemn7yhP")),
  );
});

test("events without a chunk hash keep Sentry's default grouping", () => {
  const unhashed: GroupingEvent = {
    culprit: "checkExecutionBalance(execution-gate.ts)",
    exception: {
      values: [
        {
          type: "AutumnError",
          stacktrace: {
            frames: [
              {
                filename: "/apps/cloud/src/engine/execution-gate.ts",
                function: "checkExecutionBalance",
                in_app: true,
              },
            ],
          },
        },
      ],
    },
  };
  expect(stableGroupingFingerprint(unhashed)).toBeUndefined();
  expect(stableGroupingFingerprint({})).toBeUndefined();
  expect(stableGroupingFingerprint({ exception: { values: [] } })).toBeUndefined();
});

test("a hashed culprit alone is enough to pin the fingerprint", () => {
  const culpritOnly: GroupingEvent = {
    culprit: "orElse(execution-rate-limit-BAuwphPA)",
    exception: { values: [{ type: "TypeError", value: "destroyed" }] },
  };
  expect(stableGroupingFingerprint(culpritOnly)).toEqual([
    "TypeError",
    "orElse(execution-rate-limit)",
  ]);
});

// The wrapper every process installs as its `beforeSend`. `fingerprint` and
// `tags` stand in for the fields a real Sentry event carries around it.
type SentEvent = GroupingEvent & {
  readonly fingerprint?: readonly string[] | undefined;
  readonly tags?: Record<string, string> | undefined;
};

test("withStableGroupingFingerprint pins the key and changes nothing else", () => {
  const input: SentEvent = { ...workerEvent("BAuwphPA"), tags: { a: "b" } };
  const hashed = withStableGroupingFingerprint(input);
  expect(hashed.fingerprint).toEqual([
    "GateCheckTimeoutError",
    "timeoutOrElse@execution-rate-limit",
  ]);
  // The event still carries its hashed filename, or server-side sourcemap
  // resolution would stop finding the release's artifacts.
  expect(hashed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe(
    "/assets/execution-rate-limit-BAuwphPA.js",
  );
  expect(hashed.tags).toEqual({ a: "b" });
});

test("withStableGroupingFingerprint forwards an unhashed event untouched", () => {
  const plain: SentEvent = { culprit: "checkExecutionBalance(execution-gate.ts)" };
  const out = withStableGroupingFingerprint(plain);
  expect(out).toBe(plain);
  expect("fingerprint" in out).toBe(false);
});

test("the outermost exception drives the fingerprint", () => {
  // Sentry orders `values` innermost-first; the last entry is the one whose
  // type the issue is titled with.
  const chained: GroupingEvent = {
    exception: {
      values: [
        { type: "InnerError", stacktrace: { frames: [workerFrame("BAuwphPA")] } },
        { type: "OuterError", stacktrace: { frames: [workerFrame("BAuwphPA")] } },
      ],
    },
  };
  expect(stableGroupingFingerprint(chained)?.[0]).toBe("OuterError");
});
