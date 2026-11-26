import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { ephemeralPort, portReserved, reservePortAt } from "../support/ports.ts";
import { serverControl } from "../support/server-control.ts";

layer(TestLive, { excludeTestServices: true })("Product port", (it) => {
  it.effect(scenarios.productPortReserved.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const evidence = yield* Evidence;
        const port = Number(new URL(target.metadata.origin).port);
        yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
        yield* serverControl("stop");
        const taken = yield* Effect.scoped(
          Effect.gen(function* () {
            const handedOut = yield* ephemeralPort(port);
            const reserved = yield* portReserved(port);
            const claimed = yield* reservePortAt(port);
            const attempt = { port, handedOut, reserved, claimed };
            yield* evidence.json("port-while-stopped.json", attempt);
            return attempt;
          }),
        );
        expect(
          taken,
          "nothing else on the machine can be given the stopped product's port",
        ).toEqual({
          port,
          handedOut: false,
          reserved: true,
          claimed: false,
        });
        yield* serverControl("start");
        expect(yield* portReserved(port), "the product still holds its port").toBe(true);
      }),
    ),
  );
});
