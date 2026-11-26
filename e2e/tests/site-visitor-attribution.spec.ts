import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { analyticsEvents } from "../support/collector-events.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const visitorCookie = "executor_visitor";
const postHogState = "ph_synthetic-ingestion-key_posthog";

const Session = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });

layer(TestLive, { excludeTestServices: true })("Site visitor attribution", (it) => {
  it.effect(scenarios.siteVisitorAttribution.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          onboarding = yield* Onboarding,
          target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const { edge, browser: app } = targetHosts(target);
        const cookiesAt = (origin: string) =>
          browser.use(`Read the cookies for ${origin}`, (page) =>
            page
              .context()
              .cookies(origin)
              .then((cookies) => cookies.filter((cookie) => cookie.name === visitorCookie)),
          );

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
        const now = yield* Clock.currentTimeMillis;
        expect((visitor?.expires ?? 0) * 1000 - now).toBeGreaterThan(89 * 86_400_000);
        expect(visitor?.domain).toBe(new URL(edge).hostname);
        expect(yield* cookiesAt(app)).toEqual([]);
        yield* browser.checkpoint("The site leaves its anonymous visitor ID");
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

        expect(yield* cookiesAt(app)).toEqual([]);

        const events = yield* analyticsEvents({ person: userId }).pipe(
          Effect.map((events) =>
            events.filter(
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
        expect(events[1]?.properties.signup_origin).toBe("web");
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
