import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { Onboarding } from "../support/onboarding.ts";
import { waitForLastOrganization } from "../support/organization-entry.ts";
import { SessionHint } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Last active organization", (it) => {
  it.effect(scenarios.lastOrganization.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const onboarding = yield* Onboarding;
        yield* onboarding.socialSignIn("google");
        const first = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        yield* waitForLastOrganization(first.id);
        const secondSlug = `${first.slug}-second`;
        yield* browser.use("Open the organization switcher", (page) =>
          page.getByRole("button", { name: `Organization: ${first.name}`, exact: true }).click(),
        );
        yield* browser.use("Create a second organization for this isolated user", (page) =>
          page.getByRole("menuitem", { name: "Create organization", exact: true }).click(),
        );
        yield* browser.use("Name the second organization", (page) =>
          page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Second organization"),
        );
        yield* browser.use("Set its handle", (page) =>
          page.getByRole("dialog").getByLabel("Handle", { exact: true }).fill(secondSlug),
        );
        yield* browser.use("Save the second organization", (page) =>
          page.getByRole("button", { name: "Create organization", exact: true }).click(),
        );
        yield* browser.use("The second organization opens", (page) =>
          page.waitForURL(`**/org/${secondSlug}/apps`),
        );
        const organizations = yield* onboarding.organizations;
        expect(organizations.length).toBe(2);
        const second = organizations.find((organization) => organization.slug === secondSlug);
        if (second === undefined) throw new Error("The second organization was not created");
        yield* waitForLastOrganization(second.id);
        const resume = (organization: { id: string; slug: string }) =>
          Effect.gen(function* () {
            yield* browser.use("Return to the bare root", (page) => page.goto("/"));
            yield* browser.use("Entry restores the last active organization", (page) =>
              page.waitForURL(`**/org/${organization.slug}/apps`),
            );
            yield* waitForLastOrganization(organization.id);
            expect(
              yield* browser.use("No chooser interrupts entry", (page) =>
                page.getByRole("heading", { name: "Choose an organization", exact: true }).count(),
              ),
            ).toBe(0);
          });
        yield* browser.use("An explicit link still opens the first organization", (page) =>
          page.goto(`/org/${first.slug}/apps`),
        );
        yield* waitForLastOrganization(first.id);
        yield* resume(first);
        yield* browser.use("Switch organizations inside the app", (page) =>
          page.getByRole("button", { name: `Organization: ${first.name}`, exact: true }).click(),
        );
        yield* browser.use("Select the second organization", (page) =>
          page.getByRole("menuitemradio", { name: second.name, exact: true }).click(),
        );
        yield* waitForLastOrganization(second.id);
        yield* resume(second);
        yield* browser.checkpoint("Returning users resume the organization they last used");

        const renamed = `${secondSlug}-renamed`;
        const updated = yield* browser.use("Rename through the real organization API", (page) =>
          page.context().request.post("/api/auth/organization/update", {
            headers: { origin: new URL(page.url()).origin },
            data: { organizationId: second.id, data: { slug: renamed } },
          }),
        );
        expect(updated.status()).toBe(200);
        yield* resume({ ...second, slug: renamed });
        yield* browser.checkpoint("Stable identity survives an organization rename");

        const cookies = yield* browser.use("Read the public display hint", (page) =>
          page.context().cookies(),
        );
        const cookie = cookies.find((value) => value.name.startsWith("executor-ui"));
        if (cookie === undefined) throw new Error("The navigation hint is missing");
        const hint = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionHint))(
          decodeURIComponent(cookie.value),
        );
        yield* browser.use("Represent a destination that no longer exists", (page) =>
          page.context().addCookies([
            {
              ...cookie,
              value: encodeURIComponent(
                JSON.stringify({ ...hint, lastOrganization: "missing-entry-test-organization" }),
              ),
            },
          ]),
        );
        yield* browser.use("Return with the stale destination", (page) => page.goto("/"));
        yield* browser.use(
          "Unavailable remembered organizations fall back without a loop",
          (page) =>
            page
              .getByRole("heading", { name: "Choose an organization", exact: true })
              .waitFor({ state: "visible" }),
        );
        const remaining = yield* browser.use("Read the corrected hint", (page) =>
          page.context().cookies(),
        );
        const corrected = remaining.find((value) => value.name === cookie.name);
        if (corrected === undefined) throw new Error("Recovery removed the signed-in identity");
        const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionHint))(
          decodeURIComponent(corrected.value),
        );
        expect(parsed.lastOrganization).toBeUndefined();
        yield* browser.use("The first organization remains available", (page) =>
          page.getByRole("link", { name: first.name, exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Stale history recovers to the available organizations");
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
