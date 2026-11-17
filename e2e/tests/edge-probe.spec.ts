/**
 * The temporary edge probe (`scripts/ci/edge-probe.ts`), run as CI runs it, against local stand-ins
 * for Cloudflare's edge, one for each shape the deployed suite's lost requests took:
 *
 * - an edge that answers the trace: each second is recorded as answered, with its location and its
 *   connect and handshake times;
 * - a refused connection;
 * - a reset in the handshake;
 * - a TLS alert, #1088's preparation's shape;
 * - a handshake that never completes, which times out;
 * - an HTTP error status.
 *
 * Each record names the second and the failure's kind and phase. The summary counts each kind and
 * lists the failed seconds. The detached probe stops when asked and still writes its summary, and
 * nothing it meets makes it exit with an error.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type Server, type Socket } from "node:net";
import { TLSSocket } from "node:tls";

const script = "scripts/ci/edge-probe.ts";

/** How the stand-in edge treats each connection. */
type Edge = "trace" | "reset" | "alert" | "silent" | "unavailable";

interface Probe {
  readonly t: string;
  readonly ok: boolean;
  readonly kind: string;
  readonly phase?: string;
  readonly code?: string;
  readonly status?: number;
  readonly connectMs?: number;
  readonly tlsMs?: number;
  readonly colo?: string;
}

/** A self-signed certificate for 127.0.0.1, which the probe trusts through `--ca`. */
const certificate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "edge-probe-tls-" });
  yield* processes.string(
    ChildProcess.make(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${directory}/key.pem`,
        "-out",
        `${directory}/cert.pem`,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stderr: "pipe" },
    ),
  );
  return {
    file: `${directory}/cert.pem`,
    key: yield* fs.readFileString(`${directory}/key.pem`),
    cert: yield* fs.readFileString(`${directory}/cert.pem`),
  };
});

const edge = (mode: Edge, material: { readonly key: string; readonly cert: string }) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly server: Server }>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((raw) => {
        sockets.add(raw);
        raw.on("close", () => sockets.delete(raw));
        raw.on("error", () => undefined);
        if (mode === "silent") return;
        if (mode === "reset") return void raw.once("data", () => raw.resetAndDestroy());
        // A fatal handshake_failure alert: record type 21, TLS 1.2, length 2, fatal (2), alert 40.
        if (mode === "alert")
          return void raw.once("data", () => raw.end(Buffer.from([21, 3, 3, 0, 2, 2, 40])));
        const socket = new TLSSocket(raw, { isServer: true, ...material });
        socket.on("error", () => undefined);
        socket.once("data", () => {
          const body =
            mode === "trace" ? "fl=1\nh=edge-probe\ncolo=SJC\nhttp=http/1.1\n" : "unavailable";
          socket.end(
            `HTTP/1.1 ${mode === "trace" ? "200 OK" : "503 Service Unavailable"}\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          );
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            port: typeof address === "object" && address !== null ? address.port : 0,
            server,
            sockets,
          }),
        );
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.close();
      }),
  );

/** Runs the script and returns its exit code and output; the stand-in keeps serving meanwhile. */
const node = (...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make(process.execPath, [script, ...args]));
    const [stdout, , code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout };
  }).pipe(Effect.scoped);

/** A real timer: the case's clock is a test one. */
const pause = (milliseconds: number) =>
  Effect.callback<void>((resume) => {
    setTimeout(() => resume(Effect.void), milliseconds);
  });

/** Probes the stand-in for a second and a half, five times a second, as CI runs it. */
const probe = (port: number, ca: string, extra: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "edge-probe-" });
    const run = yield* node(
      "run",
      directory,
      "--side",
      "stand-in",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ca",
      ca,
      "--interval-ms",
      "200",
      "--timeout-ms",
      "400",
      "--max-minutes",
      "0.025",
      ...extra,
    );
    expect(run.code).toBe(0);
    const probes = (yield* fs.readFileString(`${directory}/probes.ndjson`))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Probe);
    const summary = JSON.parse(yield* fs.readFileString(`${directory}/summary.json`)) as {
      readonly seconds: number;
      readonly answered: number;
      readonly failed: number;
      readonly failures: Record<string, number>;
      readonly failedSeconds: ReadonlyArray<{ readonly t: string; readonly failure: string }>;
      readonly colos: Record<string, number>;
    };
    const report = yield* node("report", directory);
    expect(report.code).toBe(0);
    return { probes, summary, markdown: report.stdout };
  });

const second = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u;

layer(NodeServices.layer)("The edge probe", (it) => {
  it.effect("records each answered second with its location and times", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      const { port } = yield* edge("trace", material);
      const { probes, summary, markdown } = yield* probe(port, material.file);
      expect(probes.length).toBeGreaterThanOrEqual(4);
      for (const answered of probes) {
        expect(answered).toMatchObject({ ok: true, kind: "ok", status: 200, colo: "SJC" });
        expect(answered.t).toMatch(second);
        expect(answered.tlsMs).toBeGreaterThanOrEqual(answered.connectMs!);
      }
      expect(summary).toMatchObject({
        failed: 0,
        answered: probes.length,
        colos: { SJC: probes.length },
      });
      expect(markdown).toContain(`${probes.length} answered, 0 failed`);
      expect(markdown).toContain(`Locations: SJC ${probes.length}.`);
    }),
  );

  it.effect("records a refused connection", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      // A port that was listening and is closed now refuses.
      const { port, server } = yield* edge("trace", material);
      yield* Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      });
      const { probes, summary } = yield* probe(port, material.file);
      expect(probes.length).toBeGreaterThanOrEqual(4);
      for (const refused of probes)
        expect(refused).toMatchObject({
          ok: false,
          kind: "connect refused",
          phase: "connect",
          code: "ECONNREFUSED",
        });
      expect(summary.failures).toEqual({ "connect refused": probes.length });
    }),
  );

  it.effect("records a reset in the handshake, with its phase", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      const { port } = yield* edge("reset", material);
      const { probes, summary, markdown } = yield* probe(port, material.file);
      for (const reset of probes)
        expect(reset).toMatchObject({ ok: false, kind: "reset", phase: "tls", code: "ECONNRESET" });
      expect(summary.failures).toEqual({ "reset (tls)": probes.length });
      expect(markdown).toContain(`| reset (tls) | ${probes.length} |`);
      expect(summary.failedSeconds.map(({ t }) => t)).toEqual(probes.map(({ t }) => t));
    }),
  );

  it.effect("records a TLS alert as a handshake failure, as #1088's preparation met", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      const { port } = yield* edge("alert", material);
      const { probes, summary } = yield* probe(port, material.file);
      for (const alert of probes)
        expect(alert).toMatchObject({
          ok: false,
          kind: "tls handshake",
          phase: "tls",
          code: "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
        });
      expect(summary.failures).toEqual({ "tls handshake": probes.length });
    }),
  );

  it.effect("records a handshake that never completes as a time-out", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      const { port } = yield* edge("silent", material);
      const { probes, summary } = yield* probe(port, material.file);
      expect(probes.length).toBeGreaterThanOrEqual(3);
      for (const silent of probes)
        expect(silent).toMatchObject({ ok: false, kind: "time-out", phase: "tls" });
      expect(summary.failures).toEqual({ "time-out (tls)": probes.length });
    }),
  );

  it.effect("records an HTTP error status with its code", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      const { port } = yield* edge("unavailable", material);
      const { probes, markdown } = yield* probe(port, material.file);
      for (const unavailable of probes)
        expect(unavailable).toMatchObject({ ok: false, kind: "http", status: 503 });
      expect(markdown).toContain(`| http 503 | ${probes.length} |`);
      expect(markdown).toMatch(/Failed seconds: \d\d:\d\d:\d\d http 503/u);
    }),
  );

  it.effect("the detached probe stops when asked and writes its summary, without failing", () =>
    Effect.gen(function* () {
      const material = yield* certificate;
      const { port } = yield* edge("trace", material);
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "edge-probe-" });
      const options = ["--host", "127.0.0.1", "--port", String(port), "--ca", material.file];
      const flags = [...options, "--interval-ms", "200", "--side", "stand-in"];
      expect((yield* node("start", directory, ...flags)).code).toBe(0);
      yield* pause(1_000);
      expect((yield* node("stop", directory)).code).toBe(0);
      const summary = JSON.parse(yield* fs.readFileString(`${directory}/summary.json`)) as {
        readonly seconds: number;
        readonly side: string;
      };
      expect(summary.side).toBe("stand-in");
      expect(summary.seconds).toBeGreaterThanOrEqual(2);
      // Stopping again, or reporting a directory with no probe, still exits cleanly.
      expect((yield* node("stop", directory)).code).toBe(0);
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "edge-probe-empty-" });
      const nothing = yield* node("report", empty);
      expect(nothing).toEqual({ code: 0, stdout: "The edge probe wrote no summary.\n" });
    }),
  );
});
