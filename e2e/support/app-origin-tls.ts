/** TLS terminates at this fixture; every HTTP handler still runs in the real self-host process. */
import { createServer } from "node:https";
import { request } from "node:http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const appOriginTls = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "app-origin-tls-" });
  const certificate = `${directory}/cert.pem`,
    key = `${directory}/key.pem`;
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
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=fixture.localhost",
        "-addext",
        "subjectAltName=DNS:fixture.localhost,DNS:*.fixture.localhost",
      ],
      { stderr: "pipe" },
    ),
  );
  const keyBytes = yield* fs.readFileString(key);
  const certBytes = yield* fs.readFileString(certificate);
  let upstream: URL | undefined;
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => {
      const server = createServer({ key: keyBytes, cert: certBytes }, (incoming, outgoing) => {
        if (upstream === undefined) {
          outgoing.writeHead(503).end();
          return;
        }
        const forwarded = request(
          {
            hostname: "127.0.0.1",
            port: upstream.port,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          },
        );
        forwarded.on("error", () => outgoing.writeHead(502).end());
        incoming.pipe(forwarded);
      });
      return new Promise<typeof server>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      });
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("TLS fixture requires TCP");
  return {
    certificate,
    origin: `https://app.fixture.localhost:${address.port}`,
    base: `https://fixture.localhost:${address.port}`,
    forward: (origin: string) => {
      upstream = new URL(origin);
    },
  };
});

/** Trust just this scenario's certificate and resolve only its loopback fixture hosts. */
export const appOriginHttpClient = (certificate: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ca = yield* fs.readFileString(certificate);
    const agent = yield* NodeHttpClient.makeAgent({
      ca,
      lookup: (hostname, options, callback) => {
        if (!hostname.endsWith(".fixture.localhost")) {
          callback(new Error("Non-fixture TLS host refused"), "", 4);
          return;
        }
        if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      },
    });
    return yield* NodeHttpClient.makeNodeHttp.pipe(
      Effect.provideService(NodeHttpClient.HttpAgent, agent),
    );
  });
