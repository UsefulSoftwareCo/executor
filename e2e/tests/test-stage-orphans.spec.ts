/**
 * The scheduled cleanup reports PlanetScale branches of deployed E2E runs that no stage lease knows
 * about. These cases run its detector as a process (`apps/hosted/cloud/scripts/test-stage-orphans.ts`,
 * the same `findOrphanBranches` cleanup calls) against a local server standing in for PlanetScale's
 * API: two pages of the test database's branches, shaped as the real list is, holding
 * production-size and retained branches beside E2E ones. Any request that is not a GET of that one
 * database's branch list is answered 500, and every request is recorded.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const organization = "synthetic-org";
const database = "executor-test";
const now = Date.parse("2026-11-13T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

/** Every kind of branch the test database holds, and one per E2E case. */
const branches = [
  // Production-size branches of the test database: never candidates, whatever their age.
  { name: "main", created_at: hoursAgo(1300) },
  { name: "idx-lock-38132096340-1", created_at: hoursAgo(800) },
  // Retained and pull-request previews have their own names and lifetimes.
  { name: "test-apps-v2-w5", created_at: hoursAgo(700) },
  { name: "test-pr-4120", created_at: hoursAgo(30) },
  // Deployed E2E runs.
  { name: "test-e2e-orphan1", created_at: hoursAgo(5) },
  { name: "test-e2e-leased1", created_at: hoursAgo(5) },
  { name: "test-e2e-young1", created_at: hoursAgo(0.5) },
  { name: "test-e2e-orphan2", created_at: hoursAgo(26) },
  { name: "test-e2e-noage1", created_at: "not a date" },
  // Shaped like an E2E branch but not one: never candidates.
  { name: "test-e2e-orphan1-copy", created_at: hoursAgo(9) },
  { name: "xtest-e2e-orphan3", created_at: hoursAgo(9) },
];

type Seen = { method: string; path: string; authorization: string | undefined };

const planetscale = (seen: Seen[]) =>
  Effect.acquireRelease(
    Effect.callback<{ origin: string; close: () => void }>((resume) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        seen.push({
          method: request.method ?? "",
          path: url.pathname + url.search,
          authorization: request.headers.authorization,
        });
        const json = (status: number, value: unknown) =>
          response
            .writeHead(status, { "content-type": "application/json" })
            .end(JSON.stringify(value));
        if (
          request.method !== "GET" ||
          url.pathname !== `/v1/organizations/${organization}/databases/${database}/branches`
        )
          return json(500, { message: "the detector asked for something it must not" });
        const page = Number(url.searchParams.get("page") ?? "1");
        const [first, second] = [branches.slice(0, 6), branches.slice(6)];
        return json(200, {
          type: "list",
          current_page: page,
          next_page: page === 1 ? 2 : null,
          data: page === 1 ? first : second,
        });
      });
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resume(Effect.succeed({ origin: `http://localhost:${port}`, close: () => server.close() }));
      });
    }),
    ({ close }) => Effect.sync(close),
  );

const environment = {
  TEST_STAGE_DATABASE: database,
  PLANETSCALE_ORGANIZATION: organization,
  PLANETSCALE_API_TOKEN_ID: "synthetic-id",
  PLANETSCALE_API_TOKEN: "synthetic-token",
};

/** Run the detector with these leases and this environment; its output and exit code. */
const detect = (leases: ReadonlyArray<string>, env: Record<string, string>, at = now) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/cloud/scripts/test-stage-orphans.ts",
          "--leases",
          leases.join(","),
          "--now",
          String(at),
        ],
        {
          env: { PATH: process.env.PATH ?? "", ...env },
          extendEnv: false,
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
        child.exitCode,
      ],
      { concurrency: 3 },
    );
    return { stdout, stderr, code: Number(code) };
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Orphaned test branches", (it) => {
  it.effect(
    "reports only test-e2e branches with no lease, older than the 3-hour lease, with GETs of one database",
    () =>
      Effect.gen(function* () {
        const seen: Seen[] = [];
        const { origin } = yield* planetscale(seen);

        const run = yield* detect(["e2e-leased1", "pr-4120"], {
          ...environment,
          TEST_STAGE_PLANETSCALE_API: origin,
        });

        expect(run.code).toBe(0);
        // A lease keeps its branch out at any age; a young branch with no lease yet, one whose age
        // cannot be read, production-size and retained branches and names only shaped like E2E ones
        // are never reported.
        expect(JSON.parse(run.stdout)).toEqual({
          orphans: ["test-e2e-orphan1", "test-e2e-orphan2"],
        });
        expect(seen.map((request) => request.path)).toEqual([
          `/v1/organizations/${organization}/databases/${database}/branches?per_page=100&page=1`,
          `/v1/organizations/${organization}/databases/${database}/branches?per_page=100&page=2`,
        ]);
        for (const request of seen) {
          expect(request.method).toBe("GET");
          expect(request.authorization).toBe("synthetic-id:synthetic-token");
        }
      }),
  );

  it.effect("does not report a branch exactly at the lease's length", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen);
      // orphan1 and leased1 are 5 hours old at `now`; 2 hours earlier they are 3 hours old.
      const run = yield* detect(
        ["e2e-leased1"],
        { ...environment, TEST_STAGE_PLANETSCALE_API: origin },
        now - 2 * 3_600_000,
      );
      expect(JSON.parse(run.stdout)).toEqual({ orphans: ["test-e2e-orphan2"] });
    }),
  );

  it.effect("fails, changing nothing, when the list cannot be read", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen);

      const run = yield* detect([], {
        ...environment,
        TEST_STAGE_DATABASE: "some-other-database",
        TEST_STAGE_PLANETSCALE_API: origin,
      });

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("PlanetScale answered 500");
      expect(seen.every((request) => request.method === "GET")).toBe(true);
    }),
  );

  it.effect(
    "sends the credentials only to a local stand-in, and does nothing without a database",
    () =>
      Effect.gen(function* () {
        const seen: Seen[] = [];
        const { origin } = yield* planetscale(seen);

        const elsewhere = yield* detect([], {
          ...environment,
          TEST_STAGE_PLANETSCALE_API: "https://planetscale.example",
        });
        expect(elsewhere.code).toBe(1);
        expect(elsewhere.stderr).toContain("may only name a local stand-in");

        const { TEST_STAGE_DATABASE: _unused, ...withoutDatabase } = environment;
        const skipped = yield* detect([], {
          ...withoutDatabase,
          TEST_STAGE_PLANETSCALE_API: origin,
        });
        expect(JSON.parse(skipped.stdout)).toEqual({ skipped: true });
        expect(seen).toEqual([]);
      }),
  );
});
