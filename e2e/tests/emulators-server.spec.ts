/**
 * CI serves emulators.dev on each E2E runner (scripts/ci/emulators.sh): the emulate-hosts Worker
 * under miniflare behind `scripts/ci/emulators-server.ts`. These cases run that server as a process
 * with a stand-in Worker that echoes what it received, and a CA and certificate made as `start`
 * makes them, and check what the Worker sees and what the client gets back: the Worker routes on its
 * URL's host, OAuth flows answer with redirects and cookies, and a client without the CA must be
 * refused, since verification stays on.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:net";

/** The stand-in Worker: one Durable Object class under the binding the real Worker uses. */
const worker = `
export class EmulatorDurableObject { fetch() { return new Response("unused"); } }
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_emulate/services")
      return Response.json({ services: [{ id: "github" }, { id: "google" }] });
    if (url.pathname === "/redirect")
      return new Response(null, { status: 302, headers: { location: "https://app.example.test/callback?code=1" } });
    if (url.pathname === "/stream") {
      let sent = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (sent === 3) return controller.close();
          sent += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.enqueue(new TextEncoder().encode("data: " + sent + "\\n\\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/cookies") {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/; Secure");
      headers.append("set-cookie", "b=2; Path=/; Secure");
      return new Response("cookies", { headers });
    }
    return Response.json({
      url: request.url,
      method: request.method,
      header: request.headers.get("x-probe"),
      body: request.method === "GET" ? null : await request.text(),
    });
  },
};
`;

/** A free local port. */
const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => resume(Effect.succeed(port)));
  });
});

/**
 * One HTTPS request to the server as `host`, with curl, trusting `ca` (a file) when given: curl
 * verifies the certificate against it, as the job's processes do.
 */
const call = (
  port: number,
  host: string,
  path: string,
  ca: string | undefined,
  init: { readonly method?: string; readonly body?: string } = {},
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(
        "curl",
        [
          "-sS",
          "-i",
          "--resolve",
          `${host}:${port}:127.0.0.1`,
          ...(ca === undefined ? [] : ["--cacert", ca]),
          "-H",
          "x-probe: kept",
          "-X",
          init.method ?? "GET",
          ...(init.body === undefined ? [] : ["--data-binary", init.body]),
          `https://${host}:${port}${path}`,
        ],
        { stderr: "pipe" },
      ),
    );
    const [out, err, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const [head = "", ...rest] = out.split("\r\n\r\n");
    const [statusLine = "", ...lines] = head.split("\r\n");
    const headers = lines.map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()] as const;
    });
    return {
      exitCode,
      error: err,
      status: Number(statusLine.split(" ")[1] ?? 0),
      header: (name: string) => headers.filter(([key]) => key === name).map(([, value]) => value),
      text: rest.join("\r\n\r\n"),
    };
  }).pipe(Effect.scoped);

/** The server, started on a free port with a stand-in Worker and a CA for emulators.dev. */
const served = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* fs.makeTempDirectoryScoped({ prefix: "emulators-server-" });
  yield* fs.writeFileString(`${state}/worker.js`, worker);
  const openssl = (args: ReadonlyArray<string>) =>
    processes.string(ChildProcess.make("openssl", args, { stderr: "pipe" }));
  yield* openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    `${state}/ca.key`,
    "-out",
    `${state}/ca.pem`,
    "-subj",
    "/CN=emulators-server test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  yield* openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${state}/leaf.key`,
    "-out",
    `${state}/leaf.csr`,
    "-subj",
    "/CN=emulators.dev",
  ]);
  yield* fs.writeFileString(
    `${state}/leaf.ext`,
    "subjectAltName=DNS:emulators.dev,DNS:*.emulators.dev\nextendedKeyUsage=serverAuth\n",
  );
  yield* openssl([
    "x509",
    "-req",
    "-in",
    `${state}/leaf.csr`,
    "-CA",
    `${state}/ca.pem`,
    "-CAkey",
    `${state}/ca.key`,
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    `${state}/leaf.ext`,
    "-out",
    `${state}/leaf.pem`,
  ]);
  const port = yield* freePort;
  yield* processes.spawn(
    ChildProcess.make("node", ["scripts/ci/emulators-server.ts", `${state}/worker.js`, state], {
      env: { EMULATORS_PORT: String(port) },
      extendEnv: true,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  // Listening once it has written the service hosts.
  for (let attempt = 0; attempt < 200; attempt++) {
    const services = `${state}/services`;
    if ((yield* fs.exists(services)) && (yield* fs.readFileString(services)).length > 0) break;
    yield* Effect.sleep("100 millis");
  }
  return { port, state, ca: `${state}/ca.pem` };
});

// Real time: the server takes a moment to listen, and the cases wait for it.
layer(NodeServices.layer, { excludeTestServices: true })("emulators.dev on the runner", (it) => {
  it.effect(
    "the Worker sees each request's own host, path, method, headers and body, and the service hosts are listed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { port, state, ca } = yield* served;
        expect(yield* fs.readFileString(`${state}/services`)).toBe("github\ngoogle\n");
        const read = yield* call(port, "github.emulators.dev", "/_emulate/manifest?x=1", ca);
        expect(read.status, read.error).toBe(200);
        // The Worker sees the host the client named, port included (443 in CI, so none there).
        expect(JSON.parse(read.text)).toEqual({
          url: `https://github.emulators.dev:${port}/_emulate/manifest?x=1`,
          method: "GET",
          header: "kept",
          body: null,
        });
        const sent = yield* call(port, "emulators.dev", "/google/instance-1/token", ca, {
          method: "POST",
          body: "grant_type=authorization_code&code=1",
        });
        expect(JSON.parse(sent.text)).toEqual({
          url: `https://emulators.dev:${port}/google/instance-1/token`,
          method: "POST",
          header: "kept",
          body: "grant_type=authorization_code&code=1",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("a redirect reaches the client unfollowed, and every cookie with it", () =>
    Effect.gen(function* () {
      const { port, ca } = yield* served;
      const redirect = yield* call(port, "google.emulators.dev", "/redirect", ca);
      expect(redirect.status, redirect.error).toBe(302);
      expect(redirect.header("location")).toEqual(["https://app.example.test/callback?code=1"]);
      const cookies = yield* call(port, "google.emulators.dev", "/cookies", ca);
      expect(cookies.header("set-cookie")).toEqual(["a=1; Path=/; Secure", "b=2; Path=/; Secure"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a streamed body reaches the client whole, as the MCP emulator streams events", () =>
    Effect.gen(function* () {
      const { port, ca } = yield* served;
      const streamed = yield* call(port, "mcp.emulators.dev", "/stream", ca);
      expect(streamed.exitCode, streamed.error).toBe(0);
      expect(streamed.header("content-type")).toEqual(["text/event-stream"]);
      expect(streamed.text).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    }).pipe(Effect.scoped),
  );

  it.effect("the bundle step lists the Worker's service hosts for the hosts file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "emulators-services-" });
      yield* fs.writeFileString(`${directory}/worker.js`, worker);
      const exitCode = yield* processes.exitCode(
        ChildProcess.make("node", [
          "scripts/ci/emulators-server.ts",
          "--services",
          `${directory}/worker.js`,
          `${directory}/services`,
        ]),
      );
      expect(exitCode).toBe(0);
      expect(yield* fs.readFileString(`${directory}/services`)).toBe("github\ngoogle\n");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the bundle step fails, writing nothing, when the Worker's catalog does not answer",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "emulators-services-" });
        yield* fs.writeFileString(
          `${directory}/worker.js`,
          `export class EmulatorDurableObject { fetch() { return new Response("unused"); } }
export default { fetch() { return Response.json({ error: "unavailable" }, { status: 503 }); } };`,
        );
        const exitCode = yield* processes.exitCode(
          ChildProcess.make(
            "node",
            [
              "scripts/ci/emulators-server.ts",
              "--services",
              `${directory}/worker.js`,
              `${directory}/services`,
            ],
            { stdout: "ignore", stderr: "ignore" },
          ),
        );
        expect(exitCode).not.toBe(0);
        expect(yield* fs.exists(`${directory}/services`)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("a client that does not trust the job's CA is refused", () =>
    Effect.gen(function* () {
      const { port } = yield* served;
      const refused = yield* call(port, "github.emulators.dev", "/", undefined);
      // curl's exit code 60: the peer certificate cannot be verified with the known CAs.
      expect(refused.exitCode).toBe(60);
      expect(refused.status).toBe(0);
    }).pipe(Effect.scoped),
  );
});
