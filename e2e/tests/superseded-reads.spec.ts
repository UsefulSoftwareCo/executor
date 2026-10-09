/** A dashboard read that a refresh supersedes while it is in flight cancels its request. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import type { Page, Request, Route } from "playwright";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

/** Billing's overview is the page's only polled read, so each poll sends it on its own. */
const overview = "**/api/organizations/*/billing";
/** Long enough that the next poll starts while the previous read is still in flight. */
const held = 1_500;
const pollInterval = 30_000;
const polls = 3;

interface Read {
  readonly request: Request;
  responded: boolean;
  ended: "finished" | "failed" | undefined;
}

layer(HostedLive, { excludeTestServices: true })("Superseded reads", (it) => {
  it.effect(scenarios.supersededReads.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const reads: Array<Read> = [];
        const observe = (page: Page) => {
          const find = (request: Request) => reads.find((read) => read.request === request);
          page.on("request", (request) => {
            if (
              request.method() === "GET" &&
              /\/api\/organizations\/[^/]+\/billing$/.test(request.url())
            )
              reads.push({ request, responded: false, ended: undefined });
          });
          page.on("response", (response) => {
            const read = find(response.request());
            if (read !== undefined) read.responded = true;
          });
          page.on("requestfinished", (request) => {
            const read = find(request);
            if (read !== undefined) read.ended = "finished";
          });
          page.on("requestfailed", (request) => {
            const read = find(request);
            if (read !== undefined) read.ended = "failed";
          });
        };
        // A cancelled read is never continued; the route then reports it is already handled.
        const hold = (route: Route) =>
          new Promise((resolve) => setTimeout(resolve, held)).then(() =>
            route.continue().catch(() => undefined),
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
        yield* browser.use("Hold every billing read in flight", (page) =>
          page.route(overview, hold),
        );
        const before = reads.length;
        for (let poll = 1; poll <= polls; poll += 1)
          yield* browser.use(`Poll ${poll} while the previous read is held`, (page) =>
            page.clock.runFor(pollInterval),
          );
        const polled = reads.slice(before);
        const latest = polled.at(-1);
        expect(polled.length, "each poll sends a read").toBe(polls);
        if (latest === undefined) return yield* Effect.die("No billing read was sent");
        yield* Effect.suspend(() =>
          latest.ended === undefined ? Effect.fail("in flight" as const) : Effect.void,
        ).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }), Effect.orDie);
        const superseded = polled.slice(0, -1);
        yield* evidence.json("superseded-reads.json", {
          reads: polled.map(({ responded, ended }) => ({ responded, ended })),
        });
        expect(latest.ended, "the latest read completes").toBe("finished");
        expect(
          superseded.map(({ ended }) => ended),
          "a superseded read cancels its request instead of leaving its response unread",
        ).toEqual(superseded.map(() => "failed"));
        expect(
          superseded.filter(({ responded }) => responded).length,
          "a superseded read never reaches the server",
        ).toBe(0);
        yield* browser.use("Release billing reads", (page) => page.unroute(overview, hold));
        yield* browser.use("Billing still shows its plans", (page) =>
          page.getByRole("heading", { name: "Team", exact: true }).waitFor(),
        );
      }),
    ),
  );
});
