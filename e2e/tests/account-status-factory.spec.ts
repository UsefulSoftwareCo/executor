/** Dynamic factories retain provider health when their optional connect check is absent. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { accountStatusSource, displayedStatus } from "../support/account-status-fixture.ts";
import { statusAccount } from "../support/status-account.ts";
import { scenarios } from "../test-plan.ts";
const dynamic = (source: string) =>
  source
    .replace("defineApp(requirements, {", "defineApp(requirements, async () => ({")
    .replace(/\}\);\s*$/, "}));");
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      checkable: Schema.Boolean,
      check: Schema.NullOr(
        Schema.Struct({ status: Schema.String, displayStatus: Schema.optionalKey(Schema.Unknown) }),
      ),
    }),
  ),
  info: Schema.Unknown,
});
layer(HostedLive, { excludeTestServices: true })("Dynamic account checks", (it) => {
  it.effect(scenarios.accountStatusFactory.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const source = (origin: string, check: string) =>
          dynamic(
            accountStatusSource(origin, check, false).replace(
              'name: "Interactive account",',
              'name: "Interactive account", health: async () => ({ accountInfo: { displayName: "Provider fallback" } }),',
            ),
          );
        const fixture = yield* statusAccount(source);
        const response = yield* fixture.check();
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const health = yield* body(Health, response);
        expect(health.apps[0]?.check?.status).toBe("healthy");
        expect(health.info).toMatchObject({ displayName: "Provider fallback" });
        const updated = yield* fixture.deploy(
          dynamic(accountStatusSource(fixture.connectOrigin, fixture.checkOrigin)),
        );
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const checked = yield* fixture.check();
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        expect((yield* body(Health, checked)).apps[0]?.check).toMatchObject({
          status: "healthy",
          displayStatus: displayedStatus,
        });
        expect(yield* fixture.statusBackend.calls).toBe(1);
        const noHandler = yield* fixture.deploy(
          dynamic(accountStatusSource(fixture.connectOrigin, fixture.checkOrigin, false)),
        );
        expect(noHandler.status, JSON.stringify(noHandler.body)).toBe(200);
        const absent = yield* fixture.check();
        expect(absent.status, JSON.stringify(absent.body)).toBe(200);
        // The old successful check may remain as stale history, but absence never writes a failure.
        expect((yield* body(Health, absent)).apps[0]?.check?.status).toBe("healthy");
        expect(yield* fixture.statusBackend.calls).toBe(1);
      }),
    ),
  );
});
