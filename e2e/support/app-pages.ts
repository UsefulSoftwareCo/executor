/** Follow a new app origin's sign-in navigations before asserting its authored UI. */
import { expect } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";

const AppLocation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), url: Schema.String }),
  Schema.Struct({
    status: Schema.Literals(["pending", "failed", "unavailable"]),
    url: Schema.Null,
  }),
]);
class DomainPending extends Schema.TaggedError<DomainPending>()("DomainPending", {}) {}

/** Pending provisioning exposes no URL; only a ready domain may enter the browser. */
export const waitForAppUrl = (session: Session, path: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const evidence = yield* Evidence;
    const statuses: string[] = [];
    const url = yield* Effect.gen(function* () {
      const response = yield* api.request(session, "GET", path);
      expect(response.status).toBe(200);
      const location = yield* body(AppLocation, response);
      if (statuses.at(-1) !== location.status) statuses.push(location.status);
      if (location.status === "pending") return yield* new DomainPending();
      if (location.status !== "ready")
        return yield* Effect.die(new Error(`App domain is ${location.status}`));
      return location.url;
    }).pipe(
      Effect.retry({
        while: Schema.is(DomainPending),
        schedule: Schedule.spaced("2 seconds"),
        times: 120,
      }),
      Effect.ensuring(
        Effect.suspend(() => evidence.json("app-domain-readiness.json", { statuses })),
      ),
    );
    return url;
  });

/** The dashboard is signed in; the new app must complete its own browser-bound handshake. */
export const openPrivateApp = (url: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const destination = new URL(url);
    const origin = destination.origin;
    yield* browser.use("A new app origin returns through its sign-in callback", (page) =>
      Promise.all([
        // A previous page can still be navigating when this starts. Observe the
        // callback's committed main frame; an unrelated aborted navigation is
        // not a failure of the new app's handshake.
        page.waitForEvent("framenavigated", {
          predicate: (frame) => {
            const value = new URL(frame.url());
            return (
              frame === page.mainFrame() &&
              value.origin === origin &&
              value.pathname === "/_executor/auth/callback"
            );
          },
        }),
        page.url() === destination.href ? page.reload() : page.goto(destination.href),
      ]),
    );
    yield* browser.use("App sign-in returns to the requested page", (page) =>
      page.waitForURL(destination.href, { waitUntil: "domcontentloaded" }),
    );
  });
