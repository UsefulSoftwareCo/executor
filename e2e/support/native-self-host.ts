/** The packaged Go host and workerd, with private data and scoped process ownership. */
import { randomBytes } from "node:crypto";
import { createServer, request as nodeRequest } from "node:http";
import { Config, Effect, FileSystem, Path, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { freePort } from "./ports.ts";
import { driver } from "./platform.ts";
import { fullTracing } from "./trace-sampling.ts";

/** Two synthetic visitors behind one actual TCP proxy. It replaces inbound IP assertions. */
export const nativeClientProxy = (upstream: string) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((incoming, outgoing) => {
          const second = incoming.url?.startsWith("/second/") === true;
          const target = new URL(incoming.url?.replace(/^\/(first|second)/, "") ?? "/", upstream);
          const request = nodeRequest(
            target,
            {
              method: incoming.method,
              headers: {
                ...incoming.headers,
                host: target.host,
                "cf-connecting-ip": second ? "198.51.100.2" : "198.51.100.1",
              },
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(outgoing);
            },
          );
          request.on("error", () => {
            outgoing.writeHead(502);
            outgoing.end();
          });
          incoming.pipe(request);
        }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const port = yield* driver(
      "start the synthetic client proxy",
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") reject(new Error("No proxy port"));
            else resolve(address.port);
          });
        }),
    );
    return { first: `http://127.0.0.1:${port}/first`, second: `http://127.0.0.1:${port}/second` };
  });

/**
 * One request to the collector's private Unix socket. The packaged host does not publish a TCP
 * port for the collector.
 */
export const collectorRequest = (socketPath: string, requestPath: string, body?: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ readonly status: number; readonly text: string }>((resolve, reject) => {
        const request = nodeRequest(
          {
            socketPath,
            path: requestPath,
            method: body === undefined ? "GET" : "POST",
            headers:
              body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                text: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        if (body !== undefined) request.write(body);
        request.end();
      }),
    catch: () => "The collector socket did not answer",
  });

export const nativeSelfHost = (environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    const binary = yield* Config.String("EXECUTOR_E2E_NATIVE_HOST").pipe(
      Config.withDefault(path.resolve(".local/native-auth/executor-host")),
    );
    const runtime = path.resolve("apps/hosted/self-host/dist/workerd");
    for (const artifact of [binary, `${runtime}/workerd.capnp`, `${runtime}/executor-collector`])
      if (!(yield* fs.exists(artifact)))
        return yield* Effect.die(
          `Missing ${artifact}. Prepare the native self-host artifacts as described in e2e/README.md; rebuild them after source changes.`,
        );
    const directory = path.resolve(".local/native-auth", randomBytes(8).toString("hex"));
    const dataDirectory = `${directory}/data`;
    const motelDirectory = `${directory}/motel`;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    // Logs survive failures. Product databases and secrets are never evidence.
    yield* Effect.addFinalizer(() =>
      fs.remove(dataDirectory, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    yield* Effect.addFinalizer(() =>
      fs.remove(motelDirectory, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    const origin = `http://127.0.0.1:${yield* freePort}`;
    const child = yield* processes.spawn(
      ChildProcess.make(binary, [], {
        extendEnv: false,
        env: {
          PATH: process.env.PATH ?? "",
          DO_NOT_TRACK: "1",
          NODE_ENV: "test",
          HOST: "127.0.0.1",
          PORT: new URL(origin).port,
          BETTER_AUTH_URL: origin,
          EXECUTOR_DATA_DIR: dataDirectory,
          EXECUTOR_MOTEL_DATA_DIR: motelDirectory,
          EXECUTOR_RUNTIME_DIR: runtime,
          // Leave OTEL_EXPORTER_OTLP_* unset so the product uses its COLLECTOR binding. Setting an
          // endpoint would export to that URL instead of the private Unix socket.
          ...fullTracing,
          ...environment,
        },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: "15 seconds",
      }),
    );
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        fs.writeFileString(`${directory}/server.log`, text, { flag: "a" }),
      ),
      Effect.forkScoped,
    );
    yield* http.get(`${origin}/.well-known/oauth-authorization-server`).pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? Effect.void : Effect.fail("Native self-host is starting"),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    );
    // The host publishes the collector socket before it accepts product traffic.
    const collectorSocket = yield* fs.readFileString(`${dataDirectory}/.executor-telemetry`).pipe(
      Effect.map((text) => text.trim()),
      Effect.filterOrFail(
        (socket) => socket.startsWith("/"),
        () => "The telemetry record does not name a socket",
      ),
      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 40 }),
    );
    const register = (headers: Readonly<Record<string, string>>, via = origin) =>
      Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(`${via}/api/auth/oauth2/register`).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJson({
              client_name: "Native rate limit fixture",
              redirect_uris: ["https://client.example.test/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              resources: [`${origin}/mcp`],
            }),
          );
          const response = yield* http.execute(request);
          const text = yield* response.text;
          return { status: response.status, headers: response.headers, text };
        }),
      );
    const oauth = (endpoint: "token" | "authorize", headers: Readonly<Record<string, string>>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const request =
            endpoint === "authorize"
              ? HttpClientRequest.get(`${origin}/api/auth/oauth2/authorize`)
              : HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
                  HttpClientRequest.bodyText(
                    "grant_type=invalid",
                    "application/x-www-form-urlencoded",
                  ),
                );
          const response = yield* http.execute(request.pipe(HttpClientRequest.setHeaders(headers)));
          const text = yield* response.text;
          return { status: response.status, headers: response.headers, text };
        }),
      );
    return {
      origin,
      collectorSocket,
      dataDirectory,
      motelDirectory,
      pid: child.pid,
      exitCode: child.exitCode,
      isRunning: child.isRunning,
      register,
      oauth,
    };
  });
