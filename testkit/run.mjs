import { runTests } from "./src/testkit.mjs";
import { renderTerminal } from "./src/render.mjs";
import { readFileSync } from "node:fs";
await import("./tests/execute.test.mjs");
await import("./tests/x-oauth-basic.test.mjs");
const { results } = await runTests();
console.log("\n──────── recordings ────────");
for (const r of results) console.log("\n" + renderTerminal(JSON.parse(readFileSync(r.file, "utf8"))));
