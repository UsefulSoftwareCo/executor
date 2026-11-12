/**
 * A scenario's product keeps its origin through every restart, whatever its neighbours on the
 * machine do. While it is stopped its port is free, so the harness keeps it reserved: outside the
 * range the OS hands to sockets that bind port zero or connect out, and in the machine's
 * reservations, which give no port to two owners.
 */
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
        // Between the stop and the start, try to take the port every way something on this
        // machine is given one. The OS gives sockets only ports in its ephemeral range, and every
        // other server the harness starts asks the reservations for its port.
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
        // The start returns once the product is ready on its own origin, which still holds the port.
        yield* serverControl("start");
        expect(yield* portReserved(port), "the product still holds its port").toBe(true);
      }),
    ),
  );
});
