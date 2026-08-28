import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";

import {
  WORKER_BUNDLER_DIRNAME,
  WORKER_BUNDLER_RUNTIME_FILES,
  missingWorkerBundlerFiles,
} from "./worker-bundler-artifact";

const STAGED_DIR = join("/opt/executor/bin", WORKER_BUNDLER_DIRNAME);

/** An existence probe that reports only the given POSIX-relative paths. */
const staged =
  (...relatives: readonly string[]) =>
  (path: string): boolean =>
    relatives.some((relative) => path === join(STAGED_DIR, ...relative.split("/")));

describe("missingWorkerBundlerFiles", () => {
  it("reports nothing when the full artifact is staged", () => {
    expect(missingWorkerBundlerFiles(STAGED_DIR, staged(...WORKER_BUNDLER_RUNTIME_FILES))).toEqual(
      [],
    );
  });

  it("reports every file when the directory is empty", () => {
    expect(missingWorkerBundlerFiles(STAGED_DIR, () => false)).toEqual([
      ...WORKER_BUNDLER_RUNTIME_FILES,
    ]);
  });

  // The regression this whole seam exists for: the packaged daemon reads the
  // wasm from disk beside the entry. A copy that brought the JS but dropped the
  // wasm used to pass the build and fail on the user's machine at startup.
  it("reports the esbuild wasm when only the JS entrypoints are staged", () => {
    expect(
      missingWorkerBundlerFiles(STAGED_DIR, staged("dist/index.js", "dist/index.bundled.js")),
    ).toEqual(["dist/esbuild.wasm"]);
  });

  // `index.bundled.js` is the file consumers load — the package's own
  // `dist/index.js` still has bare imports nothing can resolve inside the
  // compiled binary. Staging index.js alone is not enough.
  it("reports the packed entry when only the unbundled package entry is staged", () => {
    expect(
      missingWorkerBundlerFiles(STAGED_DIR, staged("dist/index.js", "dist/esbuild.wasm")),
    ).toEqual(["dist/index.bundled.js"]);
  });

  it("names files relative to the staged directory so errors are quotable", () => {
    for (const relative of WORKER_BUNDLER_RUNTIME_FILES) {
      expect(relative.startsWith("dist/")).toBe(true);
    }
  });

  it("requires the packed entry and the wasm, not just the package entry", () => {
    expect(WORKER_BUNDLER_RUNTIME_FILES).toContain("dist/index.bundled.js");
    expect(WORKER_BUNDLER_RUNTIME_FILES).toContain("dist/esbuild.wasm");
  });
});
