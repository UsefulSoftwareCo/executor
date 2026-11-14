/**
 * A stock self-host image lists Executor's official apps with no catalog setting, and
 * `EXECUTOR_CATALOG_URL=off` turns the feed off.
 *
 * The suite does not reach the live feed. A stand-in answers as `catalog.executor.sh` over HTTPS
 * on the suite's catalog network, whose subnet is public address space, because the image fetches the feed
 * through its public-only network. The image trusts the stand-in's one-day certificate through
 * `NODE_EXTRA_CA_CERTS`, as an operator's internal CA would be, without disabling verification.
 * Neither container sets `EXECUTOR_CATALOG_URL` except the one that turns the feed off.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, FileSystem, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { driver } from "../support/platform.ts";
import { containerNpmRegistry } from "../support/npm-registry.ts";
import { officialApps } from "../support/public-catalogs.ts";
import { releaseNetwork } from "../support/release-networks.ts";
import { stalledPageReport } from "../support/stalled-page.ts";

const feedHost = "catalog.executor.sh";
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#5e6ad2"/></svg>`;

/** Serves the mounted feed directory over HTTPS and logs each request's host and path. */
const feedServer = `
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
https.createServer({ cert: fs.readFileSync("/feed/cert.pem"), key: fs.readFileSync("/feed/key.pem") }, (request, response) => {
  console.log("GET " + request.headers.host + request.url);
  const file = path.join("/feed/site", path.normalize(request.url.split("?")[0]));
  if (!file.startsWith("/feed/site/") || !fs.existsSync(file)) return response.writeHead(404).end();
  response.setHeader("content-type", file.endsWith(".svg") ? "image/svg+xml" : "application/json");
  response.end(fs.readFileSync(file));
}).listen(443);
`;

const allocatePort = driver(
  "allocate port",
  () =>
    new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        listener.close(() =>
          address === null || typeof address === "string"
            ? reject(new Error("No test port"))
            : resolve(address.port),
        );
      });
    }),
);

it.live("released image lists the official app feed without a catalog setting", () =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
    const registry = yield* containerNpmRegistry;
    const run = (args: readonly string[], env: Record<string, string> = {}) =>
      processes.string(ChildProcess.make("docker", args, { env, extendEnv: true }));
    const id = `executor-catalog-${randomBytes(6).toString("hex")}`;

    // The feed's index and icons, in the shape the integrations repository publishes.
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-catalog-feed-" });
    yield* fs.makeDirectory(`${directory}/site/icons`, { recursive: true });
    yield* fs.writeFileString(
      `${directory}/site/index.json`,
      JSON.stringify({ version: 1, apps: Object.values(officialApps) }),
    );
    for (const name of ["mail-light.svg", "mail-dark.svg", "tracker.svg"])
      yield* fs.writeFileString(`${directory}/site/icons/${name}`, icon);
    yield* fs.writeFileString(`${directory}/server.js`, feedServer);
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
          `/CN=${feedHost}`,
          "-addext",
          `subjectAltName=DNS:${feedHost}`,
        ],
        { stderr: "pipe" },
      ),
    );
    // The containers read the files as their own users.
    yield* fs.chmod(directory, 0o755);
    yield* fs.chmod(`${directory}/key.pem`, 0o644);

    // Public address space, not routed anywhere outside this network.
    const network = yield* releaseNetwork("catalog");
    const feedAddress = `${network.subnet}.20`;
    const feed = `${id}-feed`;
    yield* Effect.acquireRelease(
      run([
        "run",
        "--detach",
        "--name",
        feed,
        "--network",
        network.name,
        "--ip",
        feedAddress,
        "--volume",
        `${directory}:/feed:ro`,
        "node:24-bookworm-slim",
        "node",
        "/feed/server.js",
      ]),
      () => run(["rm", "--force", feed]).pipe(Effect.orDie),
    );
    const feedRequests = run(["logs", feed]).pipe(
      Effect.map((log) => log.split("\n").filter((line) => line.startsWith("GET "))),
    );

    /** Start the image with the operator's settings and wait until it is healthy. */
    const start = (name: string, settings: Record<string, string>) =>
      Effect.gen(function* () {
        const port = yield* allocatePort;
        const origin = `http://localhost:${port}`;
        const container = `${id}-${name}`;
        const environment: Record<string, string> = {
          // Release scenarios never send product analytics, even from an image with a baked key.
          DO_NOT_TRACK: "1",
          PORT: "8080",
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          NODE_EXTRA_CA_CERTS: "/feed/cert.pem",
          ...settings,
        };
        yield* Effect.acquireRelease(
          run(
            [
              "run",
              "--detach",
              "--name",
              container,
              "--init",
              "--network",
              network.name,
              "--add-host",
              `${feedHost}:${feedAddress}`,
              "--volume",
              `${directory}/cert.pem:/feed/cert.pem:ro`,
              "--publish",
              `127.0.0.1:${port}:8080`,
              ...Object.keys(environment).flatMap((key) => ["--env", key]),
              ...registry.docker,
              image,
            ],
            environment,
          ),
          () => run(["rm", "--force", "--volumes", container]).pipe(Effect.orDie),
        );
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? // The image logs to stderr, which `run` does not read.
              processes
                .string(ChildProcess.make("docker", ["logs", container], { stderr: "pipe" }), {
                  includeStderr: true,
                })
                .pipe(Effect.flatMap(Console.error), Effect.ignore)
            : Effect.void,
        );
        yield* driver("image health", (signal) =>
          fetch(`http://127.0.0.1:${port}/health`, { signal }).then((response) =>
            response.status === 200 ? undefined : Promise.reject(new Error("not ready")),
          ),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }));
        return { origin, port };
      });

    // Each arm runs its own image container, removed before the next starts, so this scenario
    // never runs two at once beside the other release scenarios.
    // A stock image: first-run setup's account step offers the feed's apps that take an account.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stock = yield* start("stock", {});
        const browser = yield* Effect.acquireRelease(
          driver("launch the browser", () => chromium.launch()),
          (browser) => driver("close the browser", () => browser.close()).pipe(Effect.orDie),
        );
        const page = yield* driver("new browser session", () => browser.newPage());
        page.setDefaultTimeout(30_000);
        const reportStall = stalledPageReport(page);
        yield* driver("open first-run setup", () => page.goto(`${stock.origin}/login`));
        yield* driver("name the organization", () =>
          page.getByLabel("Organization name", { exact: true }).fill("Example Studio"),
        );
        yield* driver("name the administrator", () =>
          page.getByLabel("Your name", { exact: true }).fill("Alex Example"),
        );
        yield* driver("enter the administrator's email", () =>
          page.getByLabel("Email", { exact: true }).fill("alex@example.test"),
        );
        yield* driver("enter the administrator's password", () =>
          page.getByLabel("Password", { exact: true }).fill("Synthetic-catalog-password-123!"),
        );
        yield* driver("create the administrator", () =>
          page.getByRole("button", { name: "Create administrator account", exact: true }).click(),
        );
        yield* reportStall(
          driver("setup opens the account step", () =>
            page.waitForURL(/\/org\/[^/]+\/setup\/accounts$/u),
          ),
        );
        yield* driver("the account step lists the catalog", () =>
          page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
        );
        expect(
          yield* driver("read the listed apps", () =>
            page
              .getByRole("region", { name: "Apps", exact: true })
              .getByRole("group")
              .allInnerTexts(),
          ),
        ).toEqual([
          expect.stringContaining(officialApps.mail.name),
          expect.stringContaining(officialApps.tracker.name),
        ]);
        expect(yield* feedRequests).toContain(`GET ${feedHost}/index.json`);
      }),
    );

    // `off` turns the feed off: the catalog lists only the built-in Executor app, and the image
    // does not ask the feed.
    const before = (yield* feedRequests).length;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const off = yield* start("off", { EXECUTOR_CATALOG_URL: "off" });
        const headers = { origin: off.origin, "content-type": "application/json" };
        const setup = yield* driver("set up the owner", () =>
          fetch(`http://127.0.0.1:${off.port}/api/auth/self-host/setup`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: "Catalog Owner",
              email: "catalog@example.test",
              password: "Synthetic-catalog-password-123!",
              organizationName: "Catalog lab",
            }),
          }),
        );
        expect(setup.status).toBe(200);
        const cookie = setup.headers
          .getSetCookie()
          .map((part) => part.split(";")[0])
          .join("; ");
        const get = <S extends Schema.Top>(schema: S, route: string) =>
          driver(`GET ${route}`, () =>
            fetch(`http://127.0.0.1:${off.port}${route}`, { headers: { ...headers, cookie } }).then(
              (response) => response.text(),
            ),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
        const [organization] = yield* get(
          Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
          "/api/auth/organization/list",
        );
        const catalog = yield* get(
          Schema.Array(Schema.Struct({ package: Schema.String })),
          `/api/organizations/${organization.id}/catalog`,
        );
        expect(catalog.map((entry) => entry.package)).toEqual(["executor"]);
        expect((yield* feedRequests).length).toBe(before);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
