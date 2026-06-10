import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Recorder } from "./recorder.mjs";
import { McpDriver } from "./driver.mjs";
export { cookieConsentStrategy } from "../../vendor/mcporter/dist/index.js";

const RUNS = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

// A target = the per-host seam: which MCP server + how to consent (+ optional boot).
export function mcpTarget(cfg) {
  return { name: cfg.name ?? "target", server: cfg.server, consent: cfg.consent, boot: cfg.boot };
}

const tests = [];
export function mcpTest(name, target, fn) { tests.push({ name, target, fn }); }

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export async function runTests({ outDir = RUNS } = {}) {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const t of tests) {
    // the test name IS the task / opening "user" turn — the MCP surface is a chat
    const rec = new Recorder(t.name, { server: t.target.server, brain: "scripted" });
    const mcp = new McpDriver(t.target, rec);
    let ok = true, error;
    try { await t.fn(mcp); }
    catch (e) { ok = false; error = e; }
    const run = rec.finish(ok, error);
    const file = join(outDir, slug(t.name) + ".run.json");
    writeFileSync(file, JSON.stringify(run, null, 2));
    results.push({ name: t.name, ok: run.ok, file });
    console.log(`${run.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${t.name}  →  ${file.replace(process.cwd() + "/", "")}`);
    if (!run.ok && run.error) console.log(`    ${run.error}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return { results, failed };
}
