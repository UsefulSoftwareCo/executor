/**
 * Behind a reverse proxy every connection comes from the proxy, so the image counted all clients'
 * sign-ins against the proxy's one rate limit. With EXECUTOR_TRUSTED_PROXIES naming the proxy, each
 * client gets its own limit. A client never chooses its own address by sending forwarding headers,
 * through the proxy or around it: a peer that is not a listed proxy is limited by its own address,
 * as every peer is when the setting is empty. The scenario starts one image, since the suite's
 * other files start theirs at the same time.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { releaseNetwork } from "../support/release-networks.ts";

const node = "node:24-bookworm-slim";
const origin = "http://executor.example.test";

/**
 * A reverse proxy that appends the address each request came from to X-Forwarded-For, as nginx's
 * `$proxy_add_x_forwarded_for` does, and keeps whatever the client sent to its left.
 */
const proxy = (upstream: string) => `
const http = require("node:http");
http.createServer((request, response) => {
    const peer = request.socket.remoteAddress.replace(/^::ffff:/, "");
    const prior = request.headers["x-forwarded-for"];
    const headers = { ...request.headers, "x-forwarded-for": prior === undefined ? peer : prior + ", " + peer };
    const forwarded = http.request({ host: ${JSON.stringify(upstream)}, port: 8080, method: request.method, path: request.url, headers }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    forwarded.on("error", () => response.writeHead(502).end());
    request.pipe(forwarded);
}).listen(8081, "0.0.0.0");
`;

/** Wrong-password sign-ins, one after another; prints their statuses as JSON. */
const signIns = `
const [url, count, forged] = process.argv.slice(1);
(async () => {
  const statuses = [];
  for (let index = 1; index <= Number(count); index++) {
    const headers = { "content-type": "application/json", origin: ${JSON.stringify(origin)} };
    if (forged === "forge") {
      headers["x-forwarded-for"] = "198.51.100." + index;
      headers["x-executor-client-ip"] = "198.51.100." + index;
    }
    const response = await fetch(url + "/api/auth/sign-in/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "rate-limit-probe@example.test", password: "wrong" }),
    });
    await response.text();
    statuses.push(response.status);
  }
  process.stdout.write(JSON.stringify(statuses));
})();
`;

const Statuses = Schema.fromJsonString(Schema.Array(Schema.Number));

it.live(
  "released image gives each client behind a trusted reverse proxy its own sign-in limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
        const id = `proxy-rate-limit-${randomBytes(6).toString("hex")}`;
        const { name: network } = yield* releaseNetwork("proxies");
        const run = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(ChildProcess.make("docker", args, { env, extendEnv: true }));
        const container = (name: string, args: readonly string[], env?: Record<string, string>) =>
          Effect.acquireRelease(
            run(["run", "--detach", "--name", name, "--network", network, ...args], env),
            () => run(["rm", "--force", "--volumes", name]).pipe(Effect.orDie),
          );

        const trusting = `${id}-server`;
        const proxyName = `${id}-proxy`;
        yield* container(proxyName, ["--memory", "256m", node, "node", "-e", proxy(trusting)]);
        // Docker can report the address as "invalid IP" for a moment after the container starts.
        const proxyAddress = yield* run([
          "inspect",
          "--format",
          `{{.State.Status}} {{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          proxyName,
        ]).pipe(
          Effect.flatMap((output) => {
            const [status, address = ""] = output.trim().split(" ");
            return /^\d+\.\d+\.\d+\.\d+$/.test(address)
              ? Effect.succeed(address)
              : Effect.fail(`proxy container is ${status} at address ${address}`);
          }),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
        );

        const environment: Record<string, string> = {
          DO_NOT_TRACK: "1",
          PORT: "8080",
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          EXECUTOR_TRUSTED_PROXIES: proxyAddress,
        };
        yield* container(
          trusting,
          [
            "--init",
            "--memory",
            "2g",
            ...Object.keys(environment).flatMap((key) => ["--env", key]),
            image,
          ],
          environment,
        );

        // Long-lived clients, so each keeps its own address for the whole scenario.
        const client = (name: string) =>
          container(`${id}-${name}`, [
            "--memory",
            "256m",
            node,
            "node",
            "-e",
            "setInterval(() => {}, 1 << 30)",
          ]).pipe(
            Effect.as((url: string, count: number, forge = false) =>
              run([
                "exec",
                `${id}-${name}`,
                "node",
                "-e",
                signIns,
                url,
                String(count),
                forge ? "forge" : "honest",
              ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Statuses))),
            ),
          );
        const [first, second, forger, direct] = yield* Effect.all([
          client("first"),
          client("second"),
          client("forger"),
          client("direct"),
        ]);
        const throughTrusting = `http://${proxyName}:8081`;
        // The exit code is the health answer; output alone would accept a server still starting.
        yield* processes
          .exitCode(
            ChildProcess.make("docker", [
              "exec",
              `${id}-first`,
              "node",
              "-e",
              `fetch("${throughTrusting}/health").then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))`,
            ]),
          )
          .pipe(
            Effect.filterOrFail(
              (code) => code === 0,
              () => "the server is not ready through the proxy",
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 240 }),
          );

        // Each client behind the trusted proxy has its own limit.
        expect(yield* first(throughTrusting, 3)).toEqual([401, 401, 401]);
        expect(yield* second(throughTrusting, 1), "another client still signs in").toEqual([401]);

        // A client that names a new address on each try, in both headers, is still limited by
        // the address the proxy appended.
        expect(yield* forger(throughTrusting, 4, true)).toEqual([401, 401, 401, 429]);
        // A client that reaches the instance around the proxy is not trusted to name anyone.
        expect(yield* direct(`http://${trusting}:8080`, 4, true)).toEqual([401, 401, 401, 429]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  240_000,
);
