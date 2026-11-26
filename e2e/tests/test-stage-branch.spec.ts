import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const organization = "synthetic-org";
const database = "executor-test";
const branchPath = (name: string) =>
  `/v1/organizations/${organization}/databases/${database}/branches/${name}`;

type Held = {
  readonly production: boolean;
  readonly ready: boolean;
  readonly deleteStatus: number;
  readonly stays?: boolean;
  readonly answersAs?: string;
  readonly goneAfterReads?: number;
  readonly dropDelete?: boolean;
  readonly readStatus?: number;
  readonly hangRead?: boolean;
};

const bystanders: Record<string, Held> = {
  main: { production: true, ready: true, deleteStatus: 500 },
  "idx-lock-38132096340-1": { production: true, ready: true, deleteStatus: 500 },
  "test-e2e-stuck1-copy": { production: false, ready: true, deleteStatus: 500 },
  "xtest-e2e-stuck1": { production: false, ready: true, deleteStatus: 500 },
  "test-apps-v2-w5": { production: false, ready: true, deleteStatus: 500 },
};

type Seen = { method: string; path: string; authorization: string | undefined };

const planetscale = (seen: Seen[], held: Record<string, Held>) =>
  Effect.acquireRelease(
    Effect.callback<{ origin: string; close: () => void }>((resume) => {
      const branches = new Map(Object.entries({ ...bystanders, ...held }));
      const readCounts = new Map<string, number>();
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        seen.push({
          method: request.method ?? "",
          path: url.pathname,
          authorization: request.headers.authorization,
        });
        const json = (status: number, value?: unknown) =>
          response
            .writeHead(status, { "content-type": "application/json" })
            .end(value === undefined ? undefined : JSON.stringify(value));
        const prefix = branchPath("");
        if (!url.pathname.startsWith(prefix))
          return json(500, { message: "the teardown asked for something it must not" });
        const name = decodeURIComponent(url.pathname.slice(prefix.length));
        const branch = branches.get(name);
        if (request.method === "GET" && branch?.hangRead === true) return;
        const reads = (readCounts.get(name) ?? 0) + 1;
        if (request.method === "GET") readCounts.set(name, reads);
        if (
          request.method === "GET" &&
          branch?.goneAfterReads !== undefined &&
          reads > branch.goneAfterReads
        )
          branches.delete(name);
        if (request.method === "GET" && branches.get(name) === undefined)
          return json(404, { code: "not_found", message: "Not Found" });
        if (request.method === "GET")
          return branch === undefined
            ? json(404, { code: "not_found", message: "Not Found" })
            : json(branch.readStatus ?? 200, {
                type: "Branch",
                name: branch.answersAs ?? name,
                production: branch.production,
                ready: branch.ready,
              });
        if (request.method === "DELETE") {
          if (branch === undefined) return json(404, { code: "not_found" });
          if (branch.dropDelete === true) return request.socket.destroy();
          if (branch.deleteStatus >= 200 && branch.deleteStatus < 300 && branch.stays !== true)
            branches.delete(name);
          return branch.deleteStatus === 204
            ? response.writeHead(204).end()
            : json(branch.deleteStatus, { code: "forbidden", message: "Forbidden" });
        }
        return json(500, { message: "the teardown asked for something it must not" });
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

const remove = (slug: string, origin: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "node",
        ["apps/hosted/cloud/scripts/test-stage-branch.ts", "--slug", slug],
        {
          env: {
            PATH: process.env.PATH ?? "",
            ...environment,
            TEST_STAGE_PLANETSCALE_API: origin,
            TEST_STAGE_BRANCH_POLL: "20 millis",
          },
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
    expect(stderr).toBe("");
    return {
      ...(JSON.parse(stdout) as {
        outcome: { _tag: string; status?: number };
        message: string;
        leaseKept: boolean;
      }),
      code: Number(code),
    };
  }).pipe(Effect.scoped);

const stuck = { production: false, ready: false, deleteStatus: 204 } satisfies Held;

layer(NodeServices.layer, { excludeTestServices: true })("Test stage branch removal", (it) => {
  it.effect(
    "a create that never became ready: the delete goes to the exact name, and 404 is confirmed",
    () =>
      Effect.gen(function* () {
        const seen: Seen[] = [];
        const { origin } = yield* planetscale(seen, { "test-e2e-stuck1": stuck });
        const run = yield* remove("e2e-stuck1", origin);
        expect(run.code).toBe(0);
        expect(run.outcome).toEqual({ _tag: "Deleted", status: 204 });
        expect(run.leaseKept).toBe(false);
        expect(run.message).toBe(
          "PlanetScale branch test-e2e-stuck1 was left by the destroy; a delete was sent (PlanetScale answered 204) and it is gone (404).",
        );
        const at = branchPath("test-e2e-stuck1");
        expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
          ...Array.from({ length: 8 }, () => `GET ${at}`),
          `DELETE ${at}`,
          `GET ${at}`,
        ]);
        for (const request of seen)
          expect(request.authorization).toBe("synthetic-id:synthetic-token");
      }),
  );

  it.effect("a refused delete keeps the lease and says a delete was sent and refused", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-stuck2": { ...stuck, deleteStatus: 403 },
      });
      const run = yield* remove("e2e-stuck2", origin);
      expect(run.code).toBe(1);
      expect(run.outcome).toEqual({ _tag: "DeleteRefused", status: 403 });
      expect(run.leaseKept).toBe(true);
      expect(run.message).toContain(
        "PlanetScale branch test-e2e-stuck2 was left by the destroy. A delete was sent and PlanetScale refused it (403).",
      );
      expect(run.message).toContain("Its stage lease is kept");
      expect(seen.map(({ method }) => method)).toEqual([...Array(8).fill("GET"), "DELETE"]);
    }),
  );

  it.effect("a production (paid-size) branch is never sent a delete, and the lease is kept", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-paid1": { production: true, ready: true, deleteStatus: 204 },
      });
      const run = yield* remove("e2e-paid1", origin);
      expect(run.code).toBe(1);
      expect(run.outcome).toEqual({ _tag: "Production" });
      expect(run.leaseKept).toBe(true);
      expect(run.message).toContain(
        "is a production branch (created at a paid size). No delete was sent",
      );
      expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET ${branchPath("test-e2e-paid1")}`,
      ]);
    }),
  );

  it.effect("a delete accepted but still listed keeps the lease and says how long it waited", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-slow1": { ...stuck, stays: true },
      });
      const run = yield* remove("e2e-slow1", origin);
      expect(run.code).toBe(1);
      expect(run.outcome._tag).toBe("StillThere");
      expect(run.leaseKept).toBe(true);
      expect(run.message).toContain(
        "A delete was sent and accepted (204), but PlanetScale still lists it after",
      );
      expect(seen.map(({ method }) => method)).toEqual([
        ...Array(8).fill("GET"),
        "DELETE",
        ...Array(25).fill("GET"),
      ]);
    }),
  );

  it.effect("a branch already gone needs no delete, and the lease may go", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {});
      const run = yield* remove("e2e-gone1", origin);
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ _tag: "Absent" });
      expect(run.leaseKept).toBe(false);
      expect(seen.map(({ method }) => method)).toEqual(["GET"]);
    }),
  );

  it.effect("a read that answers for another branch sends no delete", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-odd1": { ...stuck, answersAs: "main" },
      });
      const run = yield* remove("e2e-odd1", origin);
      expect(run.code).toBe(1);
      expect(run.outcome).toEqual({ _tag: "Unreadable", status: 200 });
      expect(run.leaseKept).toBe(true);
      expect(seen.map(({ method }) => method)).toEqual(["GET"]);
    }),
  );

  it.effect("a branch the destroy is still deleting gets no second delete", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-owned1": { ...stuck, goneAfterReads: 3 },
      });
      const run = yield* remove("e2e-owned1", origin);
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ _tag: "Absent" });
      expect(run.leaseKept).toBe(false);
      expect(run.message).toContain("No delete was needed.");
      expect(seen.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "GET"]);
    }),
  );

  it.effect("a delete that gets no answer says a delete was sent, and keeps the lease", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-drop1": { ...stuck, dropDelete: true },
      });
      const run = yield* remove("e2e-drop1", origin);
      expect(run.code).toBe(1);
      expect(run.outcome).toEqual({ _tag: "DeleteUnanswered" });
      expect(run.leaseKept).toBe(true);
      expect(run.message).toContain("A delete was sent; no answer came back within 20 seconds.");
      expect(run.message).not.toContain("No delete was sent");
      expect(seen.map(({ method }) => method)).toEqual([...Array(8).fill("GET"), "DELETE"]);
    }),
  );

  it.effect("a read answering other than 200 or 404 sends no delete, whatever its body", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, {
        "test-e2e-err1": { ...stuck, readStatus: 500 },
      });
      const run = yield* remove("e2e-err1", origin);
      expect(run.code).toBe(1);
      expect(run.outcome).toEqual({ _tag: "Unreadable", status: 500 });
      expect(run.leaseKept).toBe(true);
      expect(seen.map(({ method }) => method)).toEqual(["GET"]);
    }),
  );

  it.effect(
    "a read that never answers is given up after 20 s, with no delete and the lease kept",
    () =>
      Effect.gen(function* () {
        const seen: Seen[] = [];
        const { origin } = yield* planetscale(seen, {
          "test-e2e-hang1": { ...stuck, hangRead: true },
        });
        const run = yield* remove("e2e-hang1", origin);
        expect(run.code).toBe(1);
        expect(run.outcome).toEqual({ _tag: "Unreadable" });
        expect(run.leaseKept).toBe(true);
        expect(run.message).toContain("could not be read (no answer within 20 seconds)");
        expect(seen.map(({ method }) => method)).toEqual(["GET"]);
      }),
    60_000,
  );

  it.effect("a name that is not a test stage's slug is refused before any request", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, { "test-e2e-stuck1": stuck });
      for (const slug of ["e2e-", "e2e-STUCK1", "e2e-stuck1/../main", "-main", ""]) {
        const run = yield* remove(slug, origin);
        expect(run.code, slug).toBe(1);
        expect(run.outcome._tag, slug).toBe("Refused");
        expect(run.leaseKept, slug).toBe(true);
        expect(run.message, slug).toContain("No request was sent.");
      }
      expect(seen).toEqual([]);
    }),
  );

  it.effect(
    "another stage's slug is read and never deleted: a branch the destroy removed lets the lease go",
    () =>
      Effect.gen(function* () {
        const seen: Seen[] = [];
        const { origin } = yield* planetscale(seen, { "test-e2e-stuck1": stuck });
        for (const slug of [
          "eapps-step1",
          "pr-4120",
          "main",
          "idx-lock-38132096340-1",
          "e2e-abcdefghijklmn",
        ]) {
          const run = yield* remove(slug, origin);
          expect(run.code, slug).toBe(0);
          expect(run.outcome, slug).toEqual({ _tag: "Absent" });
          expect(run.leaseKept, slug).toBe(false);
        }
        expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual(
          ["eapps-step1", "pr-4120", "main", "idx-lock-38132096340-1", "e2e-abcdefghijklmn"].map(
            (slug) => `GET ${branchPath(`test-${slug}`)}`,
          ),
        );
      }),
  );

  it.effect(
    "another stage's branch still there after the destroy is not deleted, and the lease is kept",
    () =>
      Effect.gen(function* () {
        const seen: Seen[] = [];
        const { origin } = yield* planetscale(seen, {});
        for (const slug of ["apps-v2-w5", "e2e-stuck1-copy"]) {
          const run = yield* remove(slug, origin);
          expect(run.code, slug).toBe(1);
          expect(run.outcome._tag, slug).toBe("NotDeleted");
          expect(run.leaseKept, slug).toBe(true);
          expect(run.message, slug).toContain("so no delete was sent");
        }
        expect(seen.filter(({ method }) => method !== "GET")).toEqual([]);
      }),
  );
});
