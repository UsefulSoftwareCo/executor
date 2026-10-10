/**
 * The site on the edge (`executor.sh`) runs PostHog anonymously. It leaves its anonymous ID in the
 * `executor_visitor` cookie, so a sign-up on the browser origin (`app.executor.sh`) can link the new
 * account to that visit with `$identify`. Every sign-in then clears the cookie, so the visit is
 * never linked to a second account.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Schedule, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const visitorCookie = "executor_visitor";
/** posthog-js keeps its state under this key with `persistence: "localStorage"`. */
const postHogState = "ph_synthetic-ingestion-key_posthog";

const Event = Schema.Struct({
  event: Schema.String,
  distinct_id: Schema.optional(Schema.String),
  properties: Schema.Record(Schema.String, Schema.Json),
});
const Batch = Schema.Struct({ batch: Schema.Array(Event) });
const readEvents = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Batch))(line).batch);
const Session = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });

layer(TestLive, { excludeTestServices: true })("Site visitor attribution", (it) => {
  it.effect(scenarios.siteVisitorAttribution.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          onboarding = yield* Onboarding,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem;
        expect(target.metadata.mode).toBe("managed");
        const { edge, browser: app } = targetHosts(target);
        const cookiesAt = (origin: string) =>
          browser.use(`Read the cookies for ${origin}`, (page) =>
            page
              .context()
              .cookies(origin)
              .then((cookies) => cookies.filter((cookie) => cookie.name === visitorCookie)),
          );

        // A first visit to the site's homepage, with its analytics on.
        yield* browser.use("Open the site's homepage", (page) => page.goto(`${edge}/`));
        const anonymousId = yield* browser.use("PostHog loads with an anonymous ID", (page) =>
          page
            .waitForFunction(
              ({ key, cookie }) => {
                const state = localStorage.getItem(key);
                return state !== null && document.cookie.includes(`${cookie}=`)
                  ? (JSON.parse(state) as { distinct_id?: unknown }).distinct_id
                  : undefined;
              },
              { key: postHogState, cookie: visitorCookie },
            )
            .then((handle) => handle.jsonValue()),
        );
        expect(anonymousId).toEqual(expect.any(String));
        const [visitor, ...others] = yield* cookiesAt(edge);
        expect(others).toEqual([]);
        expect(visitor).toMatchObject({
          value: anonymousId,
          path: "/",
          sameSite: "Lax",
          httpOnly: false,
          secure: false,
        });
        // An attributable visit lasts 90 days.
        const now = yield* Clock.currentTimeMillis;
        expect((visitor?.expires ?? 0) * 1000 - now).toBeGreaterThan(89 * 86_400_000);
        // Under `localhost` the site sets no shared `Domain`: the cookie is the edge's own, so it
        // does not reach the browser origin. Production's role hosts share their domain instead.
        expect(visitor?.domain).toBe(new URL(edge).hostname);
        expect(yield* cookiesAt(app)).toEqual([]);
        yield* browser.checkpoint("The site leaves its anonymous visitor ID");
        // Stand in for that shared `Domain`: the browser origin receives the same cookie the site set.
        yield* browser.use("Share the visitor cookie with the browser origin", (page) =>
          page.context().addCookies([
            {
              name: visitorCookie,
              value: visitor?.value ?? "",
              url: app,
              sameSite: "Lax",
              expires: visitor?.expires ?? -1,
            },
          ]),
        );
        expect((yield* cookiesAt(app)).map((cookie) => cookie.value)).toEqual([anonymousId]);

        // The visitor signs up from the site's Get started link.
        yield* onboarding.passkey;
        yield* onboarding.emailSignIn(yield* onboarding.freshEmail, "signup");
        const session = yield* browser
          .use("Read the new account's session", (page) =>
            page.evaluate(() =>
              fetch("/api/auth/get-session").then((response) => {
                if (response.status !== 200)
                  throw new Error(`Session returned HTTP ${response.status}`);
                return response.json();
              }),
            ),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
        const userId = session.user.id;

        // Signing in consumes the visitor cookie, so the visit can never reach a second account.
        expect(yield* cookiesAt(app)).toEqual([]);

        // The server links the visit to the new account before recording the sign-up.
        const events = yield* fs.readFileString(`${target.directory}/analytics.ndjson`).pipe(
          Effect.map((text) =>
            readEvents(text).filter(
              (event) =>
                event.distinct_id === userId &&
                (event.event === "$identify" || event.event === "cloud_signup_completed"),
            ),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (events) => events.some((event) => event.event === "cloud_signup_completed"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(events.map((event) => event.event)).toEqual(["$identify", "cloud_signup_completed"]);
        expect(events[0]?.properties.$anon_distinct_id).toBe(anonymousId);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
