import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { GOOGLE_OAUTH_REVIEW_FLAG, makeGoogleOAuthListing } from "./google-oauth-listing";

const context = { userId: "review-user", organizationId: "review-org" };

describe("Google OAuth review listing", () => {
  it.effect("targets the authenticated user and re-evaluates after revocation", () =>
    Effect.gen(function* () {
      let enabled = true;
      const policy = makeGoogleOAuthListing({
        projectKey: "public-project-key",
        host: "https://flags.example.com",
        fetch: async (url, init) => {
          expect(url).toBe("https://flags.example.com/flags?v=2");
          expect(await new Response(String(init?.body)).json()).toMatchObject({
            distinct_id: context.userId,
            person_properties: { executor_user_id: context.userId },
            flag_keys_to_evaluate: [GOOGLE_OAUTH_REVIEW_FLAG],
          });
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return Response.json({ flags: { [GOOGLE_OAUTH_REVIEW_FLAG]: { enabled } } });
        },
      });
      expect(yield* policy(context)).toBe(true);
      enabled = false;
      expect(yield* policy(context)).toBe(false);
    }),
  );

  for (const body of [
    { flags: {} },
    { flags: { [GOOGLE_OAUTH_REVIEW_FLAG]: { enabled: "true" } } },
    {},
  ]) {
    it.effect(`withholds an absent or invalid flag: ${JSON.stringify(body)}`, () =>
      Effect.gen(function* () {
        const policy = makeGoogleOAuthListing({
          projectKey: "key",
          host: "https://flags.example.com",
          fetch: async () => Response.json(body),
        });
        expect(yield* policy(context)).toBe(false);
      }),
    );
  }

  it.effect("withholds on HTTP and transport failures", () =>
    Effect.gen(function* () {
      const unavailable = makeGoogleOAuthListing({
        projectKey: "key",
        host: "https://flags.example.com",
        fetch: async () => new Response(null, { status: 503 }),
      });
      const failed = makeGoogleOAuthListing({
        projectKey: "key",
        host: "https://flags.example.com",
        fetch: () =>
          Effect.runPromise(Effect.fail(new DOMException("Network unavailable", "NetworkError"))),
      });
      expect(yield* unavailable(context)).toBe(false);
      expect(yield* failed(context)).toBe(false);
    }),
  );

  it.effect("does not evaluate without a user or project key", () =>
    Effect.gen(function* () {
      let requests = 0;
      const fetch: typeof globalThis.fetch = async () => {
        requests += 1;
        return Response.json({ flags: {} });
      };
      const configured = makeGoogleOAuthListing({
        projectKey: "key",
        host: "https://flags.example.com",
        fetch,
      });
      const unconfigured = makeGoogleOAuthListing({
        projectKey: undefined,
        host: "https://flags.example.com",
        fetch,
      });
      expect(yield* configured({ ...context, userId: null })).toBe(false);
      expect(yield* unconfigured(context)).toBe(false);
      expect(requests).toBe(0);
    }),
  );
});
