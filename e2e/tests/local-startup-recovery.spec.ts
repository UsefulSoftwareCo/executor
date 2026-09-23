import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { holdPort } from "../support/ports.ts";
import { serverControl } from "../support/server-control.ts";

layer(TestLive, { excludeTestServices: true })("Local startup recovery", (it) => {
  it.effect(scenarios.localStartupRecovery.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const api = yield* Api;
        const session = yield* api.session();
        yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
        yield* serverControl("stop");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* holdPort(Number(new URL(target.metadata.origin).port));
            yield* serverControl("start", 500);
          }),
        );
        yield* serverControl("start");
        const ready = yield* api.request(session, "GET", "/auth/session");
        expect(ready.status).toBe(200);
        expect(ready.body).toEqual({ authenticated: false });
      }),
    ),
  );
});
