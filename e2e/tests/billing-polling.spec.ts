/** Billing reads the billing provider; it polls quickly only while a returned checkout settles. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { Emulators } from "../support/emulators.ts";
import { Evidence } from "../support/evidence.ts";
import { batchedReads, batchPath } from "../support/read-batches.ts";
import { scenarios } from "../test-plan.ts";

/** Simulated time, advanced with the browser's clock in small steps. */
const idleMinutes = 3;
const step = 5_000;
/** Visible pages reconcile, but no more than one read per 20 seconds idle. */
const idleReadLimit = (idleMinutes * 60) / 20;
const overview = /^\/api\/organizations\/[^/]+\/billing$/;
/** A returned checkout is watched closely for two minutes. */
const settlementWindow = 120_000;
const BillingOverview = Schema.Struct({
  plans: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

layer(HostedLive, { excludeTestServices: true })("Billing polling", (it) => {
  it.effect(scenarios.billingPolling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          emulators = yield* Emulators,
          evidence = yield* Evidence;
        let reads = 0;
        let inFlight = 0;
        const observe = (page: Page) => {
          const tracked = new Set<unknown>();
          page.on("request", (request) => {
            const url = new URL(request.url());
            const count =
              request.method() === "POST" && url.pathname === batchPath
                ? batchedReads(request.postData()).filter(
                    (read) => read.group === "billing" && read.endpoint === "overview",
                  ).length
                : request.method() === "GET" && overview.test(url.pathname)
                  ? 1
                  : 0;
            if (count === 0) return;
            reads += count;
            inFlight += 1;
            tracked.add(request);
          });
          const settle = (request: unknown) => {
            if (tracked.delete(request)) inFlight -= 1;
          };
          page.on("requestfinished", settle);
          page.on("requestfailed", settle);
          // A navigation abandons the previous document's reads without always reporting them.
          page.on("framenavigated", (frame) => {
            if (frame !== page.mainFrame()) return;
            tracked.clear();
            inFlight = 0;
          });
        };
        const settled = Effect.suspend(() =>
          inFlight === 0 ? Effect.void : Effect.fail("pending" as const),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }), Effect.orDie);
        // Reads count when they start; billing provider answers need not keep pace with the clock.
        const advance = (label: string, milliseconds: number) =>
          Effect.forEach(
            Array.from({ length: milliseconds / step }),
            (_, index) =>
              browser.use(`${label}: advance ${((index + 1) * step) / 1000}s`, (page) =>
                page.clock.runFor(step),
              ),
            { discard: true },
          );
        const measure = <E, R>(name: string, effect: Effect.Effect<void, E, R>) =>
          Effect.gen(function* () {
            const before = reads;
            yield* effect;
            yield* evidence.json(`billing-reads-${name}.json`, { reads: reads - before });
            return reads - before;
          });
        const setHidden = (hidden: boolean) =>
          browser.use(hidden ? "Hide the page" : "Return to the page", (page) =>
            page.evaluate((value) => {
              if (value)
                Object.defineProperty(document, "visibilityState", {
                  configurable: true,
                  get: () => "hidden",
                });
              else Reflect.deleteProperty(document, "visibilityState");
              window.dispatchEvent(new Event("visibilitychange"));
            }, hidden),
          );

        yield* browser.login(actors.owner);
        yield* browser.use("Control the browser clock and observe billing reads", (page) =>
          page.clock.install().then(() => observe(page)),
        );
        yield* browser.use("Open billing", (page) =>
          page.goto(`/org/${actors.organization.slug}/billing`),
        );
        yield* browser.use("Billing has loaded", (page) =>
          page.getByRole("heading", { name: "Billing", exact: true }).waitFor(),
        );
        yield* settled;
        // Billing is in the navigation, and each plan states its catalog allowances and trial.
        expect(
          yield* browser.use("Billing is the current navigation entry", (page) =>
            page
              .getByRole("navigation", { name: "Main navigation" })
              .getByRole("link", { name: "Billing", exact: true })
              .getAttribute("aria-current"),
          ),
        ).toBe("page");
        const plan = (page: Page, name: string) =>
          page
            .getByRole("article")
            .filter({ has: page.getByRole("heading", { name, exact: true }) });
        expect(
          yield* browser.use("Read the Free plan", (page) => plan(page, "Free").innerText()),
        ).toMatch(/\$0 \/ month[\s\S]*Up to 3 members/u);
        yield* browser.use("Team offers its trial", (page) =>
          Promise.all([
            plan(page, "Team")
              .getByText("14-day free trial, card required", { exact: true })
              .waitFor(),
            plan(page, "Team")
              .getByRole("button", { name: "Start 14-day trial", exact: true })
              .waitFor(),
          ]),
        );
        yield* browser.checkpoint("Billing plans with their allowances");

        const visible = yield* measure(
          "visible-idle",
          advance("Visible idle", idleMinutes * 60_000),
        );
        expect(visible, "billing reconciles while visible").toBeGreaterThan(0);
        expect(visible, "billing reads while visible").toBeLessThanOrEqual(idleReadLimit);

        // A poll due at the end of a clock step reads while visible, but the read waits out the
        // page's batch window, a timer on this clock, and so starts on the next step. Hiding then
        // would count it as a hidden read. Hide right after a visible poll's read instead: the next
        // poll is due 30 simulated seconds after that one, several steps into the hidden window.
        const beforePoll = reads;
        yield* Effect.gen(function* () {
          for (let elapsed = 0; reads === beforePoll; elapsed += step) {
            if (elapsed >= idleMinutes * 60_000)
              return yield* Effect.die(`No billing read in ${idleMinutes} visible minutes`);
            yield* advance("Visible until the next poll", step);
          }
        });
        yield* settled;
        yield* setHidden(true);
        const hidden = yield* measure("hidden-idle", advance("Hidden idle", idleMinutes * 60_000));
        expect(hidden, "billing reads while hidden").toBe(0);
        yield* setHidden(false);
        yield* settled;

        // Checkout returns use their own organization, so seeding its plan changes no other case.
        const suffix = randomUUID().slice(0, 8);
        const team = yield* body(
          Organization,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
            name: `Checkout ${suffix}`,
            slug: `checkout-${suffix}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `/api/organizations/${team.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const plans = yield* body(
          BillingOverview,
          yield* api.request(actors.owner, "GET", `/api/organizations/${team.id}/billing`),
        );
        const teamPlan = plans.plans.find((plan) => plan.name === "Team");
        if (!teamPlan) return yield* Effect.die("Missing Team from the provisioned catalog");
        const returnFromCheckout = `/org/${team.slug}/billing?organization=${team.id}&plan=${teamPlan.id}`;
        const waiting = (page: Page) =>
          page.getByRole("status").filter({ hasText: "Waiting for payment confirmation." });
        const returnMarker = (page: Page) =>
          page.evaluate(() => {
            const search = new URLSearchParams(location.search);
            return search.has("plan") || search.has("organization");
          });

        // A checkout that returned for a plan not yet in effect is watched closely.
        yield* browser.use("Return from a checkout that never settles", (page) =>
          page.goto(returnFromCheckout),
        );
        yield* browser.use("Billing waits for the payment confirmation", (page) =>
          waiting(page).waitFor(),
        );
        const settling = yield* measure("checkout-settling", advance("Checkout settling", 30_000));
        expect(settling, "billing reads while a checkout settles").toBeGreaterThanOrEqual(4);
        yield* browser.checkpoint("Billing waiting for a returned checkout");

        // An abandoned checkout stops being watched closely and says so.
        const abandoned = yield* measure(
          "checkout-abandoned",
          advance("Checkout never settles", settlementWindow - 30_000 + step),
        );
        expect(abandoned, "billing reads until the window ends").toBeLessThanOrEqual(
          (settlementWindow - 30_000 + step) / step,
        );
        yield* browser.use("Billing stops waiting for the payment confirmation", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "Payment confirmation is taking longer than expected." })
            .waitFor(),
        );
        expect(
          yield* browser.use("The waiting notice is gone", (page) => waiting(page).count()),
        ).toBe(0);
        expect(
          yield* browser.use("The address no longer marks a checkout return", returnMarker),
          "a reload or bookmark does not wait again",
        ).toBe(false);
        yield* browser.checkpoint("Billing after a returned checkout never settled");
        yield* settled;
        const afterAbandon = yield* measure(
          "after-abandon",
          advance("Visible after an abandoned checkout", idleMinutes * 60_000),
        );
        expect(afterAbandon, "billing reads after the window").toBeLessThanOrEqual(idleReadLimit);
        yield* browser.use("Check the payment again", (page) =>
          page.getByRole("button", { name: "Check again", exact: true }).click(),
        );
        yield* settled;

        // A checkout that settles ends the close watch as soon as its plan is in effect.
        yield* browser.use("Return from a checkout that settles", (page) =>
          page.goto(returnFromCheckout),
        );
        yield* browser.use("Billing waits for the new payment", (page) => waiting(page).waitFor());
        yield* emulators.billingSubscription({
          organizationId: team.id,
          planId: teamPlan.id,
          status: "active",
        });
        yield* advance("Payment confirmed", 3 * step);
        yield* browser.use("The plan is in effect", (page) =>
          page
            .getByRole("article")
            .filter({ has: page.getByRole("heading", { name: "Team", exact: true }) })
            .getByRole("button", { name: "Current plan", exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("The waiting notice is gone", (page) => waiting(page).count()),
        ).toBe(0);
        expect(
          yield* browser.use("The address no longer marks a checkout return", returnMarker),
        ).toBe(false);
        yield* settled;
        const afterSettle = yield* measure(
          "after-settle",
          advance("Visible after a settled checkout", idleMinutes * 60_000),
        );
        expect(afterSettle, "billing reads after settlement").toBeLessThanOrEqual(idleReadLimit);
        yield* browser.checkpoint("Billing after a returned checkout settled");
      }).pipe(Effect.provide(Emulators.layer)),
    ),
  );
});
