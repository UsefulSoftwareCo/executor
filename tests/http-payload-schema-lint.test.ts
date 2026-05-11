import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const testRoot = join(repoRoot, ".local", "http-payload-schema-lint-tests");

const runCheck = async (name: string, files: ReadonlyArray<readonly [string, string]>) => {
  const dir = join(testRoot, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    files.map(async ([fileName, source]) => {
      const filePath = join(dir, fileName);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    }),
  );

  const result = spawnSync("bun", ["run", "scripts/check-http-payload-schemas.ts", dir], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  await rm(dir, { recursive: true, force: true });
  return result;
};

describe("HTTP payload schema lint", () => {
  it("allows structural payload schemas", async () => {
    const result = await runCheck("structural", [
      [
        "entry.ts",
        `
          import { Schema } from "effect";
          import { HttpApiEndpoint } from "effect/unstable/httpapi";

          const Payload = Schema.Struct({ name: Schema.String });

          HttpApiEndpoint.post("createThing", "/things", {
            payload: Payload,
          });
        `,
      ],
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects direct Schema.Class payload schemas", async () => {
    const result = await runCheck("direct-class", [
      [
        "entry.ts",
        `
          import { Schema } from "effect";
          import { HttpApiEndpoint } from "effect/unstable/httpapi";

          class Payload extends Schema.Class<Payload>("Payload")({
            name: Schema.String,
          }) {}

          HttpApiEndpoint.post("createThing", "/things", {
            payload: Payload,
          });
        `,
      ],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use a structural schema for HttpApiEndpoint payload");
    expect(result.stderr).toContain("Payload is Schema.Class-backed");
  });

  it("rejects re-exported class payload schemas behind namespace and const aliases", async () => {
    const result = await runCheck("reexported-alias", [
      [
        "model.ts",
        `
          import { Schema } from "effect";

          export class Payload extends Schema.Class<Payload>("Payload")({
            name: Schema.String,
          }) {}
        `,
      ],
      [
        "schema.ts",
        `
          export { Payload as ReexportedPayload } from "./model";
        `,
      ],
      [
        "entry.ts",
        `
          import { HttpApiEndpoint } from "effect/unstable/httpapi";
          import * as Schemas from "./schema";

          const PayloadAlias = Schemas.ReexportedPayload;
          const endpointOptions = {
            payload: PayloadAlias,
          };

          HttpApiEndpoint.put("updateThing", "/things/:id", endpointOptions);
        `,
      ],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Payload is Schema.Class-backed");
  });

  it("rejects class schemas nested inside structural payload schemas", async () => {
    const result = await runCheck("nested-class", [
      [
        "entry.ts",
        `
          import { Schema } from "effect";
          import { HttpApiEndpoint as Endpoint } from "effect/unstable/httpapi";

          class Item extends Schema.Class<Item>("Item")({
            name: Schema.String,
          }) {}

          const Payload = Schema.Struct({
            items: Schema.Array(Item),
          });

          Endpoint.patch("updateThings", "/things", {
            payload: Payload,
          });
        `,
      ],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Item is Schema.Class-backed");
  });
});
