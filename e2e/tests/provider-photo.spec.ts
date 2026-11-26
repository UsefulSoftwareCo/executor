import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { Onboarding } from "../support/onboarding.ts";
import { scenarios } from "../test-plan.ts";

const picture = "https://photos.example.test/provider-photo.png";
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const Session = Schema.Struct({
  user: Schema.Struct({
    email: Schema.String,
    name: Schema.String,
    image: Schema.NullOr(Schema.String),
  }),
});

layer(TestLive, { excludeTestServices: true })("Provider photos", (it) => {
  it.effect(scenarios.providerPhoto.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          browser = yield* Browser;
        const session = browser
          .use("Read the signed-in user through the public session", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
        const photoReferrers: Array<string | null> = [];
        yield* browser.use("Serve the provider photo from its external origin", (page) =>
          page.context().route(picture, (route) => {
            photoReferrers.push(route.request().headers()["referer"] ?? null);
            return route.fulfill({ contentType: "image/png", body: Buffer.from(pixel, "base64") });
          }),
        );

        yield* onboarding.passkey;
        const email = yield* onboarding.freshEmail;
        yield* onboarding.emailSignIn(email);
        yield* browser.use("Choose Not now", (page) =>
          page.getByRole("button", { name: "Not now", exact: true }).click(),
        );
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        const before = yield* session;
        expect(before.user).toMatchObject({ email, image: null });
        yield* onboarding.signOut;

        yield* onboarding.googleSignInAs({ email, name: "Provider Photo Example", picture });
        yield* browser.use("Returning user opens the existing team", (page) =>
          page.waitForURL(`**/org/${team.slug}/apps`),
        );
        const after = yield* session;
        expect(after.user).toEqual({ email, name: before.user.name, image: picture });

        const menuPhoto = yield* browser.use(
          "The account menu shows the provider photo",
          (page) => {
            const photo = page.locator(".session-menu [data-slot='avatar-image']");
            return photo.waitFor({ state: "visible" }).then(() => photo.getAttribute("src"));
          },
        );
        expect(menuPhoto).toBe(picture);
        yield* browser.checkpoint("Account menu shows the linked provider photo");

        yield* browser.use("Open organization members", (page) =>
          page.goto(`/org/${team.slug}/organization`),
        );
        const memberPhoto = yield* browser.use(
          "The members list shows the provider photo",
          (page) => {
            const photo = page
              .getByRole("table", { name: "Members" })
              .getByRole("row")
              .filter({ hasText: email })
              .locator("[data-slot='avatar-image']");
            return photo
              .scrollIntoViewIfNeeded()
              .then(() => photo.waitFor({ state: "visible" }))
              .then(() => photo.getAttribute("src"));
          },
        );
        expect(memberPhoto).toBe(picture);
        yield* browser.checkpoint("Members list shows the linked provider photo");

        expect(photoReferrers.length).toBeGreaterThan(0);
        expect(photoReferrers.every((referrer) => referrer === null)).toBe(true);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
