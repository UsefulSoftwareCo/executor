/**
 * TEMPORARY (added 16 Nov 2026). Remove it two days after it lands on main, or sooner once the
 * reader gives a clear verdict, whichever comes first.
 *
 * Probes Cloudflare's edge from a CI runner once a second, to tell whose side drops the deployed
 * suite's stage requests: those lost before Cloudflare logged them, with the stage answering other
 * requests at the same time. The deployed job runs it on Blacksmith for the length of its test
 * step. A job on a GitHub-hosted runner in the same workflow run probes the same host at the same
 * seconds. Seconds where only one side fails point at that side's network. Seconds where both fail
 * point at the edge or the host.
 *
 * Every second it opens a new TLS connection to `https://<host>/cdn-cgi/trace` and records the UTC
 * second and the outcome: answered, or the kind of failure (connect refused, reset, TLS handshake,
 * time-out, DNS, unreachable, closed, http, other) with the phase it failed in. It also records the
 * connect and handshake times and the Cloudflare location the trace names. It makes one attempt a
 * second, with a short time-out and no retries.
 *
 * The default host, `edge-probe.executor.engineering`, is in the staging zone, never production's.
 * The zone's proxied wildcard record makes the name resolve to Cloudflare. No Worker route or stage
 * owns the name, and `/cdn-cgi/trace` is answered by the edge itself, so no Worker, origin or
 * stage sees these requests.
 *
 *   node scripts/ci/edge-probe.ts start <dir> --side <name>   detached probe; returns at once
 *   node scripts/ci/edge-probe.ts stop <dir>                  stops it; it writes its summary
 *   node scripts/ci/edge-probe.ts run <dir> --side <name> [--until-job <job name>] [--max-minutes N]
 *                                                             probes in the foreground
 *   node scripts/ci/edge-probe.ts report <dir>                prints the summary, and adds it to
 *                                                             the job summary in Actions
 *
 * `--until-job` ends the probe a minute or less after that job of this workflow run completes. It
 * reads the run's jobs once a minute with the job's own token (`GH_TOKEN`). `--max-minutes`
 * (default 45) ends it in any case.
 *
 * Tests can also pass `--host`, `--port`, `--ca <file>`, `--interval-ms` and `--timeout-ms`.
 *
 * Each attempt is one line in `<dir>/probes.ndjson`. The probe also writes `summary.json` and
 * `summary.md`. It never records the runner's address, and it never fails the job: every error is
 * swallowed.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";

export type ProbeKind =
  | "ok"
  | "connect refused"
  | "reset"
  | "tls handshake"
  | "time-out"
  | "dns"
  | "unreachable"
  | "closed"
  | "http"
  | "other";
export type ProbePhase = "connect" | "tls" | "response";

export interface Probe {
  /** The UTC second the attempt started, `2026-11-16T22:30:51Z`. */
  readonly t: string;
  readonly ok: boolean;
  readonly kind: ProbeKind;
  /** Where a failed attempt stopped: the TCP connect, the TLS handshake, or the response. */
  readonly phase?: ProbePhase;
  readonly code?: string;
  readonly status?: number;
  /** Milliseconds to the TCP connection, and to the end of the TLS handshake, from the start. */
  readonly connectMs?: number;
  readonly tlsMs?: number;
  readonly totalMs: number;
  /** The Cloudflare location the trace names. */
  readonly colo?: string;
}

interface Options {
  readonly host: string;
  readonly port: number;
  readonly ca?: string;
  readonly side: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly maxMinutes: number;
  readonly untilJob?: string;
}

const defaultHost = "edge-probe.executor.engineering";

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The kind of a failed attempt, from its error code and the phase it reached. */
export const failureKind = (code: string | undefined, phase: ProbePhase): ProbeKind => {
  if (code === "ECONNREFUSED") return "connect refused";
  if (code === "ECONNRESET" || code === "EPIPE") return "reset";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "dns";
  if (code === "ETIMEDOUT") return "time-out";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") return "unreachable";
  if (phase === "tls") return "tls handshake";
  return "other";
};

const second = (at: number) =>
  `${new Date(Math.floor(at / 1000) * 1000).toISOString().slice(0, 19)}Z`;

/** One attempt: a new TLS connection, `GET /cdn-cgi/trace`, and the whole response. */
export const probeOnce = (options: Options, startedAt = Date.now()): Promise<Probe> =>
  new Promise((resolve) => {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    let phase: ProbePhase = "connect";
    let connectMs: number | undefined;
    let tlsMs: number | undefined;
    let response = "";
    let settled = false;
    let socket: TLSSocket | undefined;
    const finish = (probe: Omit<Probe, "t" | "totalMs" | "connectMs" | "tlsMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({
        t: second(startedAt),
        ...probe,
        ...(connectMs !== undefined && { connectMs }),
        ...(tlsMs !== undefined && { tlsMs }),
        totalMs: elapsed(),
      });
    };
    const timer = setTimeout(
      () => finish({ ok: false, kind: "time-out", phase }),
      options.timeoutMs,
    );
    try {
      socket = connect({
        host: options.host,
        port: options.port,
        ...(isIP(options.host) === 0 && { servername: options.host }),
        ...(options.ca !== undefined && { ca: options.ca }),
        ALPNProtocols: ["http/1.1"],
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      finish({
        ok: false,
        kind: "other",
        phase,
        ...(typeof code === "string" && { code }),
      });
      return;
    }
    socket.once("connect", () => {
      connectMs = elapsed();
      phase = "tls";
    });
    socket.once("secureConnect", () => {
      tlsMs = elapsed();
      phase = "response";
      socket!.write(
        `GET /cdn-cgi/trace HTTP/1.1\r\nhost: ${options.host}\r\nuser-agent: executor-ci-edge-probe\r\nconnection: close\r\n\r\n`,
      );
    });
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(response)?.[1]);
      const colo = /^colo=([A-Z]{3})$/mu.exec(response)?.[1];
      if (!Number.isInteger(status)) return finish({ ok: false, kind: "closed", phase });
      if (status !== 200)
        return finish({ ok: false, kind: "http", phase, status, ...(colo && { colo }) });
      finish({ ok: true, kind: "ok", status, ...(colo && { colo }) });
    });
    socket.once("error", (error) => {
      const code = (error as { code?: unknown }).code;
      const known = typeof code === "string" ? code : undefined;
      finish({
        ok: false,
        kind: failureKind(known, phase),
        phase,
        ...(known !== undefined && { code: known }),
      });
    });
    socket.once("close", () => finish({ ok: false, kind: "closed", phase }));
  });

const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** A failure's label in the summary: its kind, and the phase where that adds anything. */
const label = (probe: Probe) =>
  probe.kind === "reset" || probe.kind === "time-out" || probe.kind === "closed"
    ? `${probe.kind} (${probe.phase})`
    : probe.kind === "http"
      ? `http ${probe.status}`
      : probe.kind;

/** The record's totals, and the Markdown table the job summary shows. */
export const summarise = (probes: ReadonlyArray<Probe>, side: string, host: string) => {
  const failed = probes.filter((probe) => !probe.ok);
  const kinds = new Map<string, number>();
  for (const probe of failed) kinds.set(label(probe), (kinds.get(label(probe)) ?? 0) + 1);
  const colos = new Map<string, number>();
  for (const probe of probes)
    if (probe.colo !== undefined) colos.set(probe.colo, (colos.get(probe.colo) ?? 0) + 1);
  const connect = probes.flatMap((probe) =>
    probe.connectMs === undefined ? [] : [probe.connectMs],
  );
  const tls = probes.flatMap((probe) =>
    probe.tlsMs === undefined || probe.connectMs === undefined
      ? []
      : [probe.tlsMs - probe.connectMs],
  );
  const summary = {
    side,
    host,
    from: probes[0]?.t ?? null,
    to: probes.at(-1)?.t ?? null,
    seconds: probes.length,
    answered: probes.length - failed.length,
    failed: failed.length,
    failures: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])),
    failedSeconds: failed.map((probe) => ({ t: probe.t, failure: label(probe) })),
    colos: Object.fromEntries([...colos].sort((a, b) => b[1] - a[1])),
    connectMs: { p50: quantile(connect, 0.5), p95: quantile(connect, 0.95) },
    handshakeMs: { p50: quantile(tls, 0.5), p95: quantile(tls, 0.95) },
  };
  const time = (t: string | null) => (t === null ? "-" : t.slice(11, 19));
  const shown = 40;
  const lines = [
    `## Edge probe (${side}): https://${host}/cdn-cgi/trace`,
    "",
    `${summary.seconds} seconds probed, ${time(summary.from)}-${time(summary.to)} UTC: ${summary.answered} answered, ${summary.failed} failed. Temporary; see scripts/ci/edge-probe.ts.`,
    "",
    ...(failed.length === 0
      ? []
      : [
          "| Failure | Seconds |",
          "| --- | --- |",
          ...Object.entries(summary.failures).map(([kind, count]) => `| ${kind} | ${count} |`),
          "",
          `Failed seconds: ${summary.failedSeconds
            .slice(0, shown)
            .map(({ t, failure }) => `${time(t)} ${failure}`)
            .join(", ")}${failed.length > shown ? `, and ${failed.length - shown} more` : ""}.`,
          "",
        ]),
    `Locations: ${
      colos.size === 0
        ? "none reported"
        : Object.entries(summary.colos)
            .map(([colo, count]) => `${colo} ${count}`)
            .join(", ")
    }. Connect p50 ${summary.connectMs.p50 ?? "-"} ms, p95 ${summary.connectMs.p95 ?? "-"} ms; handshake p50 ${summary.handshakeMs.p50 ?? "-"} ms, p95 ${summary.handshakeMs.p95 ?? "-"} ms.`,
  ];
  return { summary, markdown: `${lines.join("\n")}\n` };
};

/** Whether the named job of this workflow run has completed; unknown on any error. */
const jobCompleted = async (name: string): Promise<boolean> => {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GH_TOKEN } =
    process.env;
  if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GH_TOKEN) return false;
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT ?? "1"}/jobs?per_page=100`,
      {
        headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return false;
    const { jobs } = (await response.json()) as {
      jobs?: ReadonlyArray<{ name?: string; status?: string }>;
    };
    return jobs?.some((job) => job.name === name && job.status === "completed") === true;
  } catch {
    return false;
  }
};

/** Probe every interval until stopped, then write the summary. */
const probeUntilStopped = (directory: string, options: Options) =>
  new Promise<void>((resolve) => {
    const file = join(directory, "probes.ndjson");
    const probes: Array<Probe> = [];
    const inFlight = new Set<Promise<void>>();
    const deadline = Date.now() + options.maxMinutes * 60_000;
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;

    const launch = () => {
      if (stopping) return;
      if (Date.now() >= deadline) return void stop();
      const attempt = probeOnce(options).then((probe) => {
        probes.push(probe);
        try {
          appendFileSync(file, `${JSON.stringify(probe)}\n`);
        } catch {
          // The summary still counts it.
        }
      });
      inFlight.add(attempt);
      void attempt.finally(() => inFlight.delete(attempt));
      // The next attempt starts on the next interval boundary, so both sides probe the same seconds.
      timer = setTimeout(launch, options.intervalMs - (Date.now() % options.intervalMs));
    };

    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      clearInterval(poll);
      await Promise.allSettled(inFlight);
      try {
        probes.sort((a, b) => a.t.localeCompare(b.t));
        const { summary, markdown } = summarise(probes, options.side, options.host);
        writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
        writeFileSync(join(directory, "summary.md"), markdown);
      } catch {
        // The probes remain.
      }
      resolve();
    };

    process.on("SIGTERM", () => void stop());
    process.on("SIGINT", () => void stop());
    if (options.untilJob !== undefined) {
      const name = options.untilJob;
      poll = setInterval(() => {
        void jobCompleted(name).then((done) => {
          if (done) void stop();
        });
      }, 60_000);
    }
    timer = setTimeout(launch, options.intervalMs - (Date.now() % options.intervalMs));
  });

const flag = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const optionsOf = (args: ReadonlyArray<string>): Options => {
  const number = (name: string, fallback: number) => {
    const value = Number(flag(args, name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const caFile = flag(args, "ca");
  const ca = caFile === undefined ? undefined : read(caFile);
  const untilJob = flag(args, "until-job");
  return {
    host: flag(args, "host") ?? defaultHost,
    port: number("port", 443),
    ...(ca !== undefined && { ca }),
    side: flag(args, "side") ?? "unnamed",
    intervalMs: number("interval-ms", 1_000),
    timeoutMs: number("timeout-ms", 3_000),
    maxMinutes: number("max-minutes", 45),
    ...(untilJob !== undefined && { untilJob }),
  };
};

const main = async () => {
  const [command, directory, ...args] = process.argv.slice(2);
  if (directory === undefined) return;
  if (command === "start") {
    mkdirSync(directory, { recursive: true });
    const child = spawn(process.execPath, [process.argv[1]!, "run", directory, ...args], {
      detached: true,
      stdio: "ignore",
    });
    writeFileSync(join(directory, "probe.pid"), String(child.pid));
    child.unref();
  } else if (command === "run") {
    mkdirSync(directory, { recursive: true });
    await probeUntilStopped(directory, optionsOf(args));
  } else if (command === "stop") {
    const pid = Number(read(join(directory, "probe.pid")));
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    // In-flight attempts end within their time-out; then the summary is written.
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(directory, "summary.md")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
  } else if (command === "report") {
    const markdown = read(join(directory, "summary.md"));
    if (markdown === undefined) return console.log("The edge probe wrote no summary.");
    console.log(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
};

if (import.meta.main)
  main()
    .catch(() => undefined)
    .finally(() => {
      // Never fail the job.
      process.exitCode = 0;
    });
