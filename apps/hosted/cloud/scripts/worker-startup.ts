/**
 * How long each budgeted Worker takes to start, in workerd, for two builds side by side.
 *
 *   node apps/hosted/cloud/scripts/worker-startup.ts --base <dir> --head <dir> [--runs 21]
 *     [--workers mcp-server,api]
 *
 * Each directory is a built Cloud app (`apps/hosted/cloud` after `bun run hosted:cloud:worker-sizes`,
 * which leaves `.generated/worker-uploads/` and Alchemy's `.alchemy/bundles/`), or a directory
 * holding copies of those two as `worker-uploads/` and `bundles/`. A Worker is measured when both
 * builds have an upload record for it and an entry chunk in its bundle.
 *
 * For each Worker it loads the chunks the entry imports statically (what Cloudflare compiles and
 * evaluates when an isolate starts; a chunk only `import()` reaches is left out) into a fresh
 * isolate through the Worker Loader of the workerd the repository pins, with no bindings and no
 * network, and times two things from the loader's `get` to the first response:
 *
 * - `compile`: the chunks supplied, nothing imported. workerd compiles every module it is given.
 * - `evaluate`: the same, with a main module that imports the entry, so the entry's static graph
 *   is also instantiated and evaluated.
 *
 * Base and head alternate within every run, each run in a new workerd process, and one unrecorded
 * load warms each process first. It prints JSON: per Worker, every run's milliseconds, the median
 * and the minimum, per side and mode. This is workerd on the machine that runs it, not Cloudflare's
 * edge, and its noise is the machine's: pin it to idle cores (`taskset -c 2,3 node ...`) on a
 * shared host.
 *
 * The static graph comes from V8 itself (`vm.SourceTextModule`'s requests: static imports and
 * re-exports, never `import()` or text in strings), so the script needs Node's
 * `--experimental-vm-modules`, and starts itself again with it when it is missing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, posix } from "node:path";
import vm from "node:vm";

if (!("SourceTextModule" in vm)) {
  const again = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--no-warnings", ...process.argv.slice(1)],
    { stdio: "inherit" },
  );
  process.exit(again.status ?? 1);
}

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const base = argument("base");
const head = argument("head");
const runs = Number(argument("runs") ?? 21);
const only = argument("workers")?.split(",");
if (base === undefined || head === undefined || !Number.isInteger(runs) || runs < 1) {
  console.error(
    "Usage: worker-startup.ts --base <dir> --head <dir> [--runs 21] [--workers a,b]\n" +
      "Each directory is a built apps/hosted/cloud, or holds worker-uploads/ and bundles/.",
  );
  process.exit(2);
}

/** The upload records and the bundles of one build. */
const layout = (directory: string) => {
  const nested = {
    uploads: join(directory, ".generated", "worker-uploads"),
    bundles: join(directory, ".alchemy", "bundles"),
  };
  const flat = { uploads: join(directory, "worker-uploads"), bundles: join(directory, "bundles") };
  const found = [nested, flat].find((each) => existsSync(each.uploads) && existsSync(each.bundles));
  if (found === undefined)
    throw new Error(
      `${directory} has neither .generated/worker-uploads with .alchemy/bundles nor worker-uploads with bundles`,
    );
  return found;
};

/** A chunk name that looks content-hashed (`name-<8 characters>.js`); an entry's name has no hash. */
const hashed = /-[A-Za-z0-9_-]{8}\.js$/;

/** The relative chunks a chunk imports statically, as V8 reads them. */
const staticImports = (file: string, code: string) =>
  new vm.SourceTextModule(code, { identifier: file }).moduleRequests
    .map(({ specifier }) => specifier)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => posix.normalize(posix.join(posix.dirname(file), specifier)));

/** The relative chunks a chunk loads with `import()` of a literal. */
const dynamicImports = (file: string, code: string) =>
  [...code.matchAll(/import\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*\)/g)].map((match) =>
    posix.normalize(posix.join(posix.dirname(file), match[1]!)),
  );

interface Graph {
  readonly entry: string;
  /** The entry's static chunk set, by file name. */
  readonly modules: Readonly<Record<string, string>>;
}

/** The entry chunk of `worker` in a build's bundles, and the chunks it imports statically. */
const staticGraph = (bundles: string, worker: string): Graph | undefined => {
  for (const folder of readdirSync(bundles)) {
    const directory = join(bundles, folder);
    let files: string[];
    try {
      files = readdirSync(directory).filter((file) => file.endsWith(".js"));
    } catch {
      continue;
    }
    const named = files.filter((file) => file.startsWith(`${worker}-`) || file === `${worker}.js`);
    if (named.length === 0) continue;
    // The entry is the one chunk named for the Worker without a content hash. A name such as
    // `app-data-app-data.js` looks hashed, so failing that it is the one such chunk no other chunk
    // imports (shared chunks may import from the entry, so that test alone is not enough).
    const plain = named.filter((file) => !hashed.test(file));
    let entry = plain.length === 1 ? plain[0] : undefined;
    if (entry === undefined) {
      const referenced = new Set<string>();
      for (const file of files) {
        const code = readFileSync(join(directory, file), "utf8");
        for (const target of [...staticImports(file, code), ...dynamicImports(file, code)])
          referenced.add(target);
      }
      const roots = named.filter((file) => !referenced.has(file));
      entry = roots.length === 1 ? roots[0] : undefined;
    }
    if (entry === undefined) continue;
    const modules: Record<string, string> = {};
    const pending = [entry];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (modules[file] !== undefined) continue;
      const code = readFileSync(join(directory, file), "utf8");
      modules[file] = code;
      for (const target of staticImports(file, code))
        if (existsSync(join(directory, target))) pending.push(target);
    }
    return { entry, modules };
  }
  return undefined;
};

const workersOf = (uploads: string) =>
  readdirSync(uploads)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));

const sides = { base: layout(base), head: layout(head) } as const;
const names = workersOf(sides.base.uploads)
  .filter((worker) => workersOf(sides.head.uploads).includes(worker))
  .filter((worker) => only === undefined || only.includes(worker))
  .sort();

const sets: Record<string, Graph> = {};
const measured: string[] = [];
const skipped: Record<string, string> = {};
for (const worker of names) {
  const graphs = {
    base: staticGraph(sides.base.bundles, worker),
    head: staticGraph(sides.head.bundles, worker),
  };
  if (graphs.base === undefined || graphs.head === undefined) {
    skipped[worker] = "no entry chunk in one of the bundles";
    continue;
  }
  sets[`${worker}:base`] = graphs.base;
  sets[`${worker}:head`] = graphs.head;
  measured.push(worker);
}

/** The pinned workerd's binary: the package's CommonJS main exports its path as `default`. */
const workerdPackage = createRequire(import.meta.url)("workerd") as { readonly default: string };
const workerdBinary = workerdPackage.default;

const compatibility = {
  date: "2026-09-08",
  flags: ["nodejs_compat", "no_brotli_content_encoding"],
};

/** The Worker that loads each set through its Worker Loader and times it. */
const harness = `import sets from "./sets.json";
let loads = 0;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const set = sets[url.searchParams.get("set")];
    const evaluate = url.searchParams.get("mode") === "evaluate";
    const main = evaluate
      ? \`import * as entry from "./\${set.entry}"; export default { fetch() { return new Response(typeof entry); } };\`
      : \`export default { fetch() { return new Response("compiled"); } };\`;
    const started = Date.now();
    try {
      const worker = env.LOADER.get(\`load-\${loads++}\`, () => ({
        compatibilityDate: ${JSON.stringify(compatibility.date)},
        compatibilityFlags: ${JSON.stringify(compatibility.flags)},
        mainModule: "harness-main.js",
        modules: { "harness-main.js": main, ...set.modules },
        globalOutbound: null,
      }));
      const response = await worker.getEntrypoint().fetch("http://startup.invalid/");
      await response.text();
    } catch (error) {
      return Response.json({ error: String(error).slice(0, 500) });
    }
    return Response.json({ ms: Date.now() - started });
  },
};
`;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

const work = mkdtempSync(join(tmpdir(), "worker-startup-"));
writeFileSync(join(work, "sets.json"), JSON.stringify(sets));
writeFileSync(join(work, "harness.js"), harness);

/** Start one workerd process serving the harness; resolves its origin once it answers. */
const startWorkerd = async () => {
  const port = await freePort();
  writeFileSync(
    join(work, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "harness", worker = (
    modules = [(name = "harness.js", esModule = embed "harness.js"), (name = "sets.json", json = embed "sets.json")],
    compatibilityDate = "${compatibility.date}",
    compatibilityFlags = ${JSON.stringify(compatibility.flags)},
    bindings = [(name = "LOADER", workerLoader = ())]))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "harness")]);
`,
  );
  const child = spawn(workerdBinary, ["serve", join(work, "config.capnp"), "--experimental"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`workerd exited: ${stderr}`);
    try {
      await fetch(origin);
      return { origin, stop: () => child.kill() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error(`workerd did not answer: ${stderr}`);
};

const load = async (origin: string, set: string, mode: "compile" | "evaluate") => {
  const response = await fetch(`${origin}/?set=${encodeURIComponent(set)}&mode=${mode}`);
  const body = (await response.json()) as { ms?: number; error?: string };
  if (body.ms === undefined) throw new Error(`${set} ${mode}: ${body.error ?? response.status}`);
  return body.ms;
};

type Side = "base" | "head";
type Mode = "compile" | "evaluate";
const samples: Record<string, Record<Mode, Record<Side, number[]>>> = Object.fromEntries(
  measured.map((worker) => [
    worker,
    { compile: { base: [], head: [] }, evaluate: { base: [], head: [] } },
  ]),
);

const loadBefore = loadavg();
try {
  for (let run = 0; run < runs; run++) {
    const server = await startWorkerd();
    try {
      // The first load of a process also warms the harness itself; it is not recorded.
      const first = measured[0];
      if (first !== undefined) await load(server.origin, `${first}:base`, "compile");
      const order: Side[] = run % 2 === 0 ? ["base", "head"] : ["head", "base"];
      for (const mode of ["compile", "evaluate"] as const)
        for (const worker of measured)
          for (const side of order)
            samples[worker]![mode][side].push(await load(server.origin, `${worker}:${side}`, mode));
    } finally {
      server.stop();
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const summary = (values: readonly number[]) => ({
  runs: values,
  median: median(values),
  min: Math.min(...values),
});
const bytes = (graph: Graph) =>
  Object.values(graph.modules).reduce((total, code) => total + Buffer.byteLength(code), 0);

console.log(
  JSON.stringify(
    {
      workerd: JSON.parse(
        readFileSync(new URL(import.meta.resolve("workerd/package.json")), "utf8"),
      ).version,
      runs,
      machine: { cpus: cpus().length, loadBefore, loadAfter: loadavg() },
      workers: Object.fromEntries(
        measured.map((worker) => [
          worker,
          {
            entry: { base: sets[`${worker}:base`]!.entry, head: sets[`${worker}:head`]!.entry },
            staticModules: {
              base: Object.keys(sets[`${worker}:base`]!.modules).length,
              head: Object.keys(sets[`${worker}:head`]!.modules).length,
            },
            staticBytes: {
              base: bytes(sets[`${worker}:base`]!),
              head: bytes(sets[`${worker}:head`]!),
            },
            compile: {
              base: summary(samples[worker]!.compile.base),
              head: summary(samples[worker]!.compile.head),
            },
            evaluate: {
              base: summary(samples[worker]!.evaluate.base),
              head: summary(samples[worker]!.evaluate.head),
            },
          },
        ]),
      ),
      skipped,
    },
    null,
    2,
  ),
);
