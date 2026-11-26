import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const resolve = createRequire(import.meta.url);
const workerdBinary = (resolve("workerd") as { readonly default: string }).default;
const esbuildBinary = resolve.resolve("esbuild/bin/esbuild");
const deadlineMs = 60_000;
const holderBoundMs = 10_000;
const stopGraceMs = 2_000;

class Unfinished extends Error {}
class SetupFailed extends Error {}

const deadline = AbortSignal.timeout(deadlineMs);
const unfinished = () => new Unfinished(`the check did not finish within ${deadlineMs / 1000} s`);
const pause = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    if (deadline.aborted) return reject(unfinished());
    const timer = setTimeout(() => {
      deadline.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(unfinished());
    };
    deadline.addEventListener("abort", stop, { once: true });
  });
const until = async (done: () => boolean, ms: number) => {
  for (const started = Date.now(); !done(); await pause(20))
    if (Date.now() - started > ms) return false;
  return true;
};
const bounded = async <A>(work: Promise<A>) => {
  try {
    return await work;
  } catch (error) {
    if (deadline.aborted) throw unfinished();
    throw error;
  }
};

type Owned = { readonly process: ChildProcess; spawnError?: NodeJS.ErrnoException; stderr: string };
const owned: { work?: string; children: Array<Owned>; upstream?: Server } = { children: [] };
const spawnOwned = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
  const child: Owned = {
    process: spawn(command, args, { ...options, detached: true }),
    stderr: "",
  };
  owned.children.push(child);
  child.process.on("error", (error: NodeJS.ErrnoException) => void (child.spawnError = error));
  child.process.stderr?.on(
    "data",
    (chunk: Buffer) => void (child.stderr = (child.stderr + chunk).slice(-4000)),
  );
  return child;
};
const signalGroup = ({ process: child }: Owned, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
};
const exited = ({ process }: Owned) => process.exitCode !== null || process.signalCode !== null;
const childGone = (child: Owned) =>
  child.process.pid === undefined || exited(child)
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), stopGraceMs);
        child.process.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
let released: Promise<void> | undefined;
const release = () =>
  (released ??= (async () => {
    owned.upstream?.close();
    for (const child of owned.children) {
      if (child.process.pid === undefined) continue;
      signalGroup(child, "SIGTERM");
      if (!(await childGone(child))) {
        signalGroup(child, "SIGKILL");
        await childGone(child);
      }
      signalGroup(child, "SIGKILL");
    }
    if (owned.work !== undefined) rmSync(owned.work, { recursive: true, force: true });
  })());
process.on("exit", () => {
  for (const child of owned.children) signalGroup(child, "SIGKILL");
  if (owned.work !== undefined) rmSync(owned.work, { recursive: true, force: true });
});
let signalled: number | undefined;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)
  process.on(signal, () => {
    if (signalled !== undefined) return;
    signalled = code;
    void release().finally(() => process.exit(code));
  });

const awaitExit = async (child: Owned, what: string) => {
  await until(() => child.spawnError !== undefined || exited(child), deadlineMs);
  if (child.spawnError !== undefined)
    throw new SetupFailed(
      `${what} could not start (${child.spawnError.code ?? child.spawnError.message})`,
    );
  if (child.process.exitCode !== 0)
    throw new SetupFailed(
      `${what} exited ${child.process.exitCode ?? child.process.signalCode}: ${child.stderr}`,
    );
};

const startWorkerd = async (work: string) => {
  writeFileSync(
    join(work, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "harness", worker = (
      modules = [(name = "harness.js", esModule = embed "harness.js")],
      compatibilityDate = "2026-09-08",
      globalOutbound = "internet")),
    (name = "internet", network = (allow = ["private", "public", "local"]))],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "harness")]);
`,
  );
  const child = spawnOwned(
    workerdBinary,
    ["serve", join(work, "config.capnp"), "--experimental", "--control-fd=3"],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  let control = "";
  let port: number | undefined;
  (child.process.stdio[3] as NodeJS.ReadableStream | null)?.on("data", (chunk: Buffer) => {
    control += chunk.toString();
    for (const line of control.split("\n")) {
      try {
        const message = JSON.parse(line) as { event?: string; socket?: string; port?: number };
        if (message.event === "listen" && message.socket === "http") port = message.port;
      } catch {}
    }
  });
  const ready = await until(
    () => port !== undefined || child.spawnError !== undefined || exited(child),
    15_000,
  );
  if (child.spawnError !== undefined)
    throw new SetupFailed(
      `workerd could not start (${child.spawnError.code ?? child.spawnError.message})`,
    );
  if (port === undefined)
    throw new SetupFailed(
      `workerd did not report its port (${ready ? `exited ${child.process.exitCode}` : "no answer in 15 s"}): ${child.stderr}`,
    );
  return port;
};

const failures: Array<string> = [];
const main = async () => {
  const work = mkdtempSync(join(tmpdir(), "build-read-holder-"));
  owned.work = work;
  let accepted = 0;
  let onAccept = () => {};
  const upstream = createServer((socket: Socket) => {
    accepted += 1;
    socket.on("error", () => {});
    onAccept();
  });
  owned.upstream = upstream;
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  await awaitExit(
    spawnOwned(
      esbuildBinary,
      [
        join(here, "build-read-holder-harness.ts"),
        "--bundle",
        "--format=esm",
        "--platform=browser",
        "--conditions=workerd,worker,browser",
        "--external:cloudflare:*",
        "--external:node:*",
        "--log-level=error",
        `--outfile=${join(work, "harness.js")}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    ),
    "the harness bundler",
  );
  const port = await startWorkerd(work);
  const origin = `http://127.0.0.1:${port}`;
  const get = async <A>(path: string) =>
    (await (await bounded(fetch(`${origin}${path}`, { signal: deadline }))).json()) as A;
  type Load = { ok: boolean; ms: number; reads: number; error?: string };
  const load = (build: string) => get<Load>(`/?build=${build}`);
  const state = () => get<{ reads: number; hungEnded: number }>("/state");
  await state();

  // external: workerd cancels a request whose client connection is reset; a plain close goes unnoticed while the request waits.
  const holder = connect(port, "127.0.0.1");
  holder.on("error", () => {});
  onAccept = () => holder.resetAndDestroy();
  holder.write(
    `GET /?build=bld_held&hang=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/`)} HTTP/1.1\r\nHost: harness\r\n\r\n`,
  );
  if (!(await until(() => accepted === 1, 5_000)))
    throw new SetupFailed("the holder's read never reached the silent upstream");
  // external: workerd keeps a dropped request's upstream socket open, so the drop is read from the holder's own fiber: it never ends, not even at its read's own bound.
  await pause(holderBoundMs + 1_000);
  const afterCut = await state();
  if (afterCut.reads !== 1) throw new SetupFailed(`the holder made ${afterCut.reads} reads, not 1`);
  if (afterCut.hungEnded !== 0)
    throw new SetupFailed(
      "the holder's read ran on after its client left and ended at its own bound: the runtime did not drop it",
    );
  const control = await load("bld_free");
  const later = await load("bld_held");
  const again = await load("bld_held");
  console.log(
    JSON.stringify({ holderReads: afterCut.reads, holderDropped: true, control, later, again }),
  );
  if (!control.ok) failures.push(`the control build failed: ${JSON.stringify(control)}`);
  if (!later.ok || later.reads !== 1)
    failures.push(
      `a load of the build whose earlier read was cut in flight ${later.ok ? "answered" : "failed"} after ${later.ms} ms with ${later.reads} reads of its own (wanted: answered after its own read): ${later.error ?? ""}`,
    );
  if (!again.ok || again.reads !== 0)
    failures.push(
      `the load after that ${again.ok ? "answered" : "failed"} after ${again.ms} ms with ${again.reads} reads of its own (wanted: answered from memory)`,
    );
};

let exitCode = 0;
try {
  await main();
  if (failures.length > 0) {
    console.error(
      `A cut build read held up later loads of its build:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
    exitCode = 1;
  } else console.log("A build read cut in flight holds up no later load of its build.");
} catch (error) {
  if (error instanceof Unfinished) console.error(`${error.message}; no result about the reader.`);
  else if (error instanceof SetupFailed)
    console.error(
      `The check could not set up its cut, so it says nothing about the reader: ${error.message}`,
    );
  else console.error(`The check failed before a result: ${String(error)}`);
  exitCode = 2;
} finally {
  await release();
}
process.exit(signalled ?? exitCode);
