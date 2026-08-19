// ---------------------------------------------------------------------------
// Measure the Worker's *evaluated* module closures from the build output.
// ---------------------------------------------------------------------------
//
// Upload size does not predict cold-isolate cost: a Worker can ship megabytes
// that never load, and the bytes that matter are the ones an isolate must
// evaluate before it can answer. Rollup already separates static from dynamic
// edges, so we can compute that split directly instead of reading totals.
//
// Two closures matter:
//   startup - statically reachable from the Worker entry. Evaluated on every
//             cold isolate before any request is served.
//   start   - the TanStack Start server graph, reached through the lazy
//             `loadEntries` dynamic imports. Evaluated on the first request
//             that enters the app.
//
// Anything reachable only through a dynamic import is not counted: making a
// heavy dependency lazy is exactly the outcome this rewards.
//
// Scope note: this measures bytes, which is a proxy for cold-start cost, not a
// proven cause of any particular regression. The Aug 2026 MCP incident was
// NOT explained by this number - reverting the offending packages moved the
// evaluated closure by 0.02 MB while restoring production latency, so
// module-scope execution cost, not size, drove that one. Treat a budget breach
// as "this will make cold starts worse", not as "this is why the site is slow".
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist/server");
const ENTRY = join(DIST, "index.js");

// Rollup emits `from "./x.js"`, bare `import "./x.js"`, `export ... from "./x.js"`
// (all static) and `import("./x.js")` (dynamic). Matching the emitted output
// rather than source means we see the graph as the runtime sees it.
const STATIC_RE = /(?:from|import)\s*["'](\.[^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["'](\.[^"']+)["']\s*\)/g;

const listChunks = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listChunks(join(dir, e.name))
      : e.name.endsWith(".js")
        ? [join(dir, e.name)]
        : [],
  );

const graph = new Map();
for (const file of listChunks(DIST)) {
  const code = readFileSync(file, "utf8");
  const dynamic = new Set([...code.matchAll(DYNAMIC_RE)].map((m) => resolve(dirname(file), m[1])));
  // A specifier inside `import(...)` also matches STATIC_RE's `import` branch,
  // so subtract the dynamic set rather than trusting the static matches alone.
  const staticDeps = new Set(
    [...code.matchAll(STATIC_RE)]
      .map((m) => resolve(dirname(file), m[1]))
      .filter((p) => !dynamic.has(p)),
  );
  graph.set(file, { size: statSync(file).size, static: staticDeps, dynamic });
}

/** Bytes evaluated when `roots` are loaded, following static edges only. */
const closure = (roots) => {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !graph.has(file)) continue;
    seen.add(file);
    queue.push(...graph.get(file).static);
  }
  return seen;
};

const bytes = (files) => [...files].reduce((sum, f) => sum + (graph.get(f)?.size ?? 0), 0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const name = (f) => relative(DIST, f);

const startup = closure([ENTRY]);
// The lazy server-graph entries Start pulls on first request.
const startRoots = [...graph.get(ENTRY).dynamic].filter((f) =>
  /(start|router|tanstack)/.test(name(f)),
);
const start = closure(startRoots);
const evaluated = new Set([...startup, ...start]);

const report = (label, files) => {
  console.log(`\n${label}: ${mb(bytes(files))}  (${files.size} chunks)`);
  const own = [...files].filter((f) => !startup.has(f) || label === "startup");
  for (const f of own.sort((a, b) => graph.get(b).size - graph.get(a).size).slice(0, 12)) {
    console.log(`   ${(graph.get(f).size / 1024).toFixed(0).padStart(6)} KB  ${name(f)}`);
  }
};

report("startup", startup);
report("start", start);
console.log(`\ntotal evaluated on a warm-path request: ${mb(bytes(evaluated))}`);
const lazyOnly = [...graph.keys()].filter((f) => !evaluated.has(f));
console.log(
  `deferred behind dynamic import:        ${mb(bytes(lazyOnly))}  (${lazyOnly.length} chunks)`,
);

const budget = Number(process.env.START_CLOSURE_BUDGET_MB ?? 0);
if (budget > 0) {
  const actual = bytes(evaluated) / 1024 / 1024;
  console.log(`\nbudget ${budget} MB — actual ${actual.toFixed(2)} MB`);
  if (actual > budget) {
    console.error(
      `\nFAIL: evaluated closure ${actual.toFixed(2)} MB exceeds the ${budget} MB budget.\n` +
        `Every cold isolate pays to evaluate this closure before it can answer. Move the\n` +
        `new weight behind a dynamic import rather than raising the budget; run this\n` +
        `script with no budget set to see the biggest members and what is already lazy.`,
    );
    process.exit(1);
  }
}
