import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { test } from "bun:test";
import { main } from "../src/main.ts";

test("self-host serves until it stops", async () => {
  const code = await new Promise<number>((resolve) => {
    process.exit = ((code?: number) => resolve(code ?? 0)) as typeof process.exit;
    BunRuntime.runMain(main);
  });
  process.exitCode = code;
});
