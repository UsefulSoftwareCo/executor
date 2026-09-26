/** Run the perf emulator on loopback, or bundle and upload it as a workers.dev Worker. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Config, Console, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { emulatorRoutes } from "./emulator.ts";

export class EmulatorFailed extends Schema.TaggedError<EmulatorFailed>()("EmulatorFailed", {
  message: Schema.String,
}) {}

/** Scoped loopback emulator for self-host and local targets; returns its origin. */
export const serveEmulator = (port: number, host = "127.0.0.1") =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(emulatorRoutes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host, port })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* new EmulatorFailed({ message: "No TCP port" });
    return `http://${host}:${server.address.port}`;
  });

const CloudflareResult = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
});

/**
 * Bundle the Worker entry with Bun and upload it through the Cloudflare API, then enable its
 * workers.dev route. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (the staging launcher).
 */
export const deployEmulator = (name: string) =>
  Effect.gen(function* () {
    if (!/^perf-[a-z0-9-]*-0925$/.test(name))
      return yield* new EmulatorFailed({ message: "Emulator Workers are named perf-*-0925" });
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const directory = yield* fs.makeTempDirectoryScoped();
    const output = path.join(directory, "worker.js");
    const code = Number(
      yield* spawner.exitCode(
        ChildProcess.make(
          "bun",
          [
            "build",
            path.resolve("e2e/benchmarks/perf/emulator-worker.ts"),
            "--target=browser",
            "--format=esm",
            "--minify",
            `--outfile=${output}`,
          ],
          { stdout: "inherit", stderr: "inherit" },
        ),
      ),
    );
    if (code !== 0) return yield* new EmulatorFailed({ message: "Bundling failed" });
    const script = yield* fs.readFileString(output);
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(token))),
    );
    const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers`;
    const check =
      (operation: string) =>
      (response: { status: number; json: Effect.Effect<unknown, unknown> }) =>
        Effect.gen(function* () {
          const value = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CloudflareResult)),
            Effect.mapError(
              () => new EmulatorFailed({ message: `${operation}: invalid response` }),
            ),
          );
          if (!value.success)
            return yield* new EmulatorFailed({
              message: `${operation} failed (HTTP ${response.status})`,
            });
          return value.result;
        });
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.js",
            compatibility_date: "2025-09-01",
            observability: { enabled: false },
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.set(
      "worker.js",
      new Blob([script], { type: "application/javascript+module" }),
      "worker.js",
    );
    yield* http
      .execute(
        HttpClientRequest.put(`${api}/scripts/${name}`).pipe(HttpClientRequest.bodyFormData(form)),
      )
      .pipe(Effect.flatMap(check("Upload")));
    yield* http
      .execute(
        yield* HttpClientRequest.post(`${api}/scripts/${name}/subdomain`).pipe(
          HttpClientRequest.bodyJson({ enabled: true, previews_enabled: false }),
        ),
      )
      .pipe(Effect.flatMap(check("Enable workers.dev")));
    const subdomain = yield* http
      .execute(HttpClientRequest.get(`${api}/subdomain`))
      .pipe(
        Effect.flatMap(check("Read workers.dev subdomain")),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ subdomain: Schema.String }))),
      );
    const origin = `https://${name}.${subdomain.subdomain}.workers.dev`;
    yield* Console.log(JSON.stringify({ name, origin }));
    return origin;
  }).pipe(Effect.scoped);
