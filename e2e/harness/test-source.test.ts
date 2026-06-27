import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { extractFocusedTestSource, writeFocusedTestSource } from "../src/test-source";

describe("focused test source evidence", () => {
  it.effect("extracts a named direct KVM-style test and writes source provenance", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-test-source-"))),
      (directory) =>
        Effect.sync(() => {
          const testFile = join(directory, "gui-acceptance.test.ts");
          const runDir = join(directory, "run");
          const directName = "Desktop KVM account switching";
          mkdirSync(runDir);
          writeFileSync(
            testFile,
            `// Direct packaged guest acceptance.
import { expect, it } from "@effect/vitest";

const SCENARIO_NAME = ${JSON.stringify(directName)};
const helper = () => "focused helper";

scenario("Unrelated shared scenario", {}, Effect.void);

it(SCENARIO_NAME, async () => {
  expect(helper()).toBe("focused helper");
});
`,
          );

          const extracted = extractFocusedTestSource(testFile, directName);
          expect(extracted?.registration).toBe("it");
          expect(extracted?.source).toContain("Direct packaged guest acceptance");
          expect(extracted?.source).toContain("it(SCENARIO_NAME");
          expect(extracted?.source).toContain("focused helper");
          expect(extracted?.source).not.toContain("Unrelated shared scenario");
          expect(extracted?.source).not.toContain("@effect/vitest");

          expect(
            writeFocusedTestSource({ runDir, filePath: testFile, testName: directName }),
          ).toBeDefined();
          expect(readFileSync(join(runDir, "test.ts"), "utf8")).toBe(extracted?.source);
          expect(
            JSON.parse(readFileSync(join(runDir, "test-source-metadata.json"), "utf8")),
          ).toMatchObject({
            schemaVersion: 1,
            sourcePath: "gui-acceptance.test.ts",
            testName: directName,
            registration: "it",
            extractor: "typescript-named-test-v2",
          });
        }),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    ),
  );

  it.effect("finds scenario registrations nested inside preflight branches", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-nested-test-source-"))),
      (directory) =>
        Effect.sync(() => {
          const testFile = join(directory, "preflight.test.ts");
          const selectedName = "Packaged desktop preflight";
          writeFileSync(
            testFile,
            `import { scenario } from "../src/scenario";

const preflight = { status: "ready" };
const SCENARIO_NAME = "Packaged desktop";

if (preflight.status === "skip") {
  scenario(\`\${SCENARIO_NAME} preflight\`, {}, Effect.die("unavailable"));
} else {
  scenario("Packaged desktop survives restart", {}, Effect.void);
  scenario("Packaged desktop sibling", {}, Effect.void);
}
`,
          );

          const extracted = extractFocusedTestSource(testFile, selectedName);
          expect(extracted?.registration).toBe("scenario");
          expect(extracted?.source).toContain("if (preflight.status");
          expect(extracted?.source).toContain("scenario(`${SCENARIO_NAME} preflight`");
          expect(extracted?.source).not.toContain("survives restart");
          expect(extracted?.source).not.toContain("Packaged desktop sibling");
          expect(extracted?.source).not.toContain("../src/scenario");
        }),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    ),
  );
});
