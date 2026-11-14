/**
 * The billing overview answers a person within its own deadline, so while Autumn is slow it sends
 * one read and says it is unavailable within that deadline, rather than retrying. The faults match every caller of
 * an Autumn route, so this file runs on its own local Cloud.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Layer, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { Emulators } from "../support/emulators.ts";
import { Onboarding } from "../support/onboarding.ts";
import { scenarios } from "../test-plan.ts";

const services = Layer.mergeAll(Onboarding.layer, Emulators.layer);
const Response = Schema.Struct({ status: Schema.Number, body: Schema.Unknown });
/** Longer than any deadline below, so a read that is sent never answers in time. */
const neverInTime = 25_000;

/** Fetch a Cloud API path as the signed-in browser session. */
const get = (step: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser
      .use(step, (page) =>
        page.evaluate(
          (path) =>
            fetch(path).then((response) =>
              response.json().then((body: unknown) => ({ status: response.status, body })),
            ),
          path,
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Response)));
  });

/** How long an effect took, in milliseconds, with its result. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const result = yield* effect;
    return { result, ms: (yield* Clock.currentTimeMillis) - start };
  });

layer(TestLive, { excludeTestServices: true })("Cloud slow Autumn", (it) => {
  it.effect(scenarios.slowAutumnDeadlines.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          emulators = yield* Emulators,
          browser = yield* Browser;
        const armed: string[] = [];
        /** Arm a fault on an Autumn route whose reads never answer in time. */
        const stall = (route: "plans.list") =>
          emulators
            .failAutumnReads(route, { status: 200, delayMs: neverInTime, times: 3 })
            .pipe(Effect.tap((id) => Effect.sync(() => armed.push(id))));
        /** How many reads a fault armed by `stall` has answered. */
        const sent = (id: string) =>
          emulators.autumnFaults.pipe(Effect.map((faults) => 3 - (faults.get(id) ?? 0)));

        yield* Effect.gen(function* () {
          const identity = yield* emulators.identity("google");
          yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
          yield* onboarding.chooseSocial("google");
          yield* browser.use("Choose the account on the Google emulator", (page) =>
            page.getByRole("button").filter({ hasText: identity.email }).click(),
          );
          yield* onboarding.prepareTeam;
          yield* browser.use("Create the team", (page) =>
            page.getByRole("button", { name: "Continue", exact: true }).click(),
          );
          yield* browser.use("Team creation opens the team's account step", (page) =>
            page.waitForURL((url) => /^\/org\/[^/]+\/setup\/accounts$/u.test(url.pathname)),
          );
          const [team] = yield* onboarding.organizations;
          if (team === undefined) return yield* Effect.die("The team was not created");
          const billing = `/api/organizations/${team.id}/billing`;

          // The overview creates the customer, then lists plans once within Autumn's timeout.
          const catalog = yield* stall("plans.list");
          const overview = yield* timed(
            get("Read billing while Autumn's plan list stalls", billing),
          );
          expect(overview.result).toMatchObject({
            status: 503,
            body: { _tag: "BillingUnavailable" },
          });
          // One ten-second plan list after a prompt customer write.
          expect(overview.ms).toBeLessThan(15_000);
          expect(yield* sent(catalog)).toBe(1);

          yield* emulators.clearAutumnFault(catalog);
          expect((yield* get("Read billing once Autumn answers", billing)).status).toBe(200);
        }).pipe(
          Effect.ensuring(
            Effect.forEach(armed, emulators.clearAutumnFault, { discard: true }).pipe(Effect.orDie),
          ),
        );
      }).pipe(Effect.provide(services)),
    ),
  );
});
