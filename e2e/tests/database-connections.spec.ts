/**
 * A deployed run's database connection latency: the levels at their thresholds, the run's
 * figure from its minutes, and the check after teardown that the stage's PlanetScale branch is
 * gone. A local server stands in for PlanetScale's API and records what it was asked.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { connectionLevel } from "../database-connections.ts";
import { confirmBranchDeleted } from "../sdk/branch-deleted.ts";
import { summarize } from "../sdk/database-connections.ts";

const slug = "e2e-synth0";
const organization = "synthetic-org";
const database = "synthetic-db";
const tokenId = "SYNTHETIC-ID-0001";
const token = "pscale_SYNTHETIC-token-0001";

type Seen = { path: string; authorization: string | undefined };

/** PlanetScale's branch read, answering `status` every time. */
const planetscale = (seen: Seen[], status: number) =>
  Effect.acquireRelease(
    Effect.callback<{ origin: string; close: () => void }>((resume) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        seen.push({ path: request.url ?? "", authorization: request.headers.authorization });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(status === 404 ? { code: "not_found" } : { name: "branch" }));
      });
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resume(Effect.succeed({ origin: `http://localhost:${port}`, close: () => server.close() }));
      });
    }),
    ({ close }) => Effect.sync(close),
  );

/** An origin nothing listens on. */
const unreachable = Effect.callback<string>((resume) => {
  const server = createServer();
  server.listen(0, () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resume(Effect.succeed(`http://localhost:${port}`)));
  });
});

const credentials = (values: Record<string, string>) =>
  Layer.mergeAll(FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromUnknown(values)));
const withPlanetscale = credentials({
  PLANETSCALE_ORGANIZATION: organization,
  TEST_STAGE_DATABASE: database,
  PLANETSCALE_API_TOKEN_ID: tokenId,
  PLANETSCALE_API_TOKEN: token,
});
const quickly = { spacing: "10 millis", attempts: 2 } as const;

/** The failure's message, which must name the branch. */
const failureOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
      ? exit.cause.reasons[0].error.message
      : "no failure",
  );

layer(NodeServices.layer, { excludeTestServices: true })("Database connections", (it) => {
  it.effect("levels a run's connection latency at each threshold", () =>
    Effect.sync(() => {
      // The average alone: elevated from 10 ms, severe from 50 ms.
      expect([9.9, 10, 49.9, 50].map((averageMs) => connectionLevel(averageMs, 0))).toEqual([
        "normal",
        "elevated",
        "elevated",
        "severe",
      ]);
      // The worst minute alone: elevated from 100 ms, severe from 300 ms.
      expect([99, 100, 299, 300].map((worstMinuteMs) => connectionLevel(0, worstMinuteMs))).toEqual(
        ["normal", "elevated", "elevated", "severe"],
      );
      // Either one reaching a level is enough.
      expect(connectionLevel(9.9, 300)).toBe("severe");
      expect(connectionLevel(50, 99)).toBe("severe");
    }),
  );

  it.effect("weighs each minute by its statements and leaves out minutes under 100", () =>
    Effect.sync(() => {
      expect(
        summarize("hyperdrive", [
          { queries: 100, latencyMs: 10 },
          { queries: 300, latencyMs: 2 },
          // Too few statements to say anything about the pool: neither the average nor the worst.
          { queries: 99, latencyMs: 999 },
        ]),
      ).toEqual({
        source: "hyperdrive",
        level: "normal",
        averageMs: 4,
        worstMinuteMs: 10,
        minutes: 2,
        queries: 400,
      });
      expect(
        summarize("spans", [
          { queries: 200, latencyMs: 60 },
          { queries: 200, latencyMs: 40 },
        ]),
      ).toEqual({
        source: "spans",
        level: "severe",
        averageMs: 50,
        worstMinuteMs: 60,
        minutes: 2,
        queries: 400,
      });
      expect(summarize("spans", [{ queries: 99, latencyMs: 5 }])).toBeUndefined();
    }),
  );

  it.effect("confirms a deleted branch from PlanetScale's 404", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, 404);
      yield* confirmBranchDeleted(slug, { api: origin, ...quickly }).pipe(
        Effect.provide(withPlanetscale),
      );
      expect(seen).toEqual([
        {
          path: `/organizations/${organization}/databases/${database}/branches/test-${slug}`,
          authorization: `${tokenId}:${token}`,
        },
      ]);
    }),
  );

  it.effect("fails naming a branch PlanetScale still lists, after every attempt", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      const { origin } = yield* planetscale(seen, 200);
      const message = yield* failureOf(
        confirmBranchDeleted(slug, { api: origin, ...quickly }).pipe(
          Effect.provide(withPlanetscale),
        ),
      );
      expect(message).toContain(`PlanetScale branch test-${slug} was not confirmed deleted`);
      expect(message).toContain("PlanetScale still answers 200");
      expect(seen).toHaveLength(quickly.attempts + 1);
    }),
  );

  it.effect("fails naming the branch when PlanetScale cannot be reached or read", () =>
    Effect.gen(function* () {
      const origin = yield* unreachable;
      const unreached = yield* failureOf(
        confirmBranchDeleted(slug, { api: origin, ...quickly }).pipe(
          Effect.provide(withPlanetscale),
        ),
      );
      expect(unreached).toContain(`PlanetScale branch test-${slug}`);
      expect(unreached).toContain("PlanetScale could not be reached");
      const uncredentialed = yield* failureOf(
        confirmBranchDeleted(slug, { api: origin, ...quickly }).pipe(
          Effect.provide(credentials({ PLANETSCALE_ORGANIZATION: organization })),
        ),
      );
      expect(uncredentialed).toContain(`PlanetScale branch test-${slug}`);
      expect(uncredentialed).toContain("no PlanetScale credentials");
    }),
  );
});
