/** The Accounts tab offers member actions only on contributed requirements and their own links. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { ok } from "../support/app-links.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { contributedApp } from "../support/contributed-app.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Contributed Accounts tab", (it) => {
  it.effect(scenarios.contributedAppAccountsBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* contributedApp;
        const browser = yield* Browser;
        const { actors, ids } = f;
        yield* f.role(ids.admin, "member");
        const own = yield* f.connect(actors.member, "app", "shared", "My service account");
        yield* f.connect(actors.owner, "app", "shared", "Another member's account");
        yield* f.connect(actors.owner, "app", "ordinary", "Manager-only account");
        yield* browser.login(actors.member);
        yield* browser.use("Open contributed accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${f.app.id}?view=accounts`),
        );
        yield* browser.use("My contribution names me", (page) =>
          page.getByText("Added by you", { exact: true }).waitFor(),
        );
        yield* browser.use("Members can add an account to the contributed requirement", (page) =>
          page
            .getByRole("region", { name: "Contributed service (shared)", exact: true })
            .getByRole("button", { name: "Connect new account", exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Read contributed account controls", (page) => {
            const contributed = page.getByRole("region", {
              name: "Contributed service (shared)",
              exact: true,
            });
            const ordinary = page.getByRole("region", {
              name: "Contributed service (ordinary)",
              exact: true,
            });
            return Promise.all([
              contributed
                .getByRole("checkbox", { name: "My service account", exact: true })
                .isEnabled(),
              contributed
                .getByRole("checkbox", { name: "Another member's account", exact: true })
                .isDisabled(),
              contributed
                .getByRole("button", { name: "Manage Another member's account", exact: true })
                .count(),
              ordinary.getByRole("button", { name: "Connect new account", exact: true }).count(),
            ]);
          }),
        ).toEqual([true, true, 0, 0]);
        yield* browser.use("The ordinary requirement explains its permission", (page) =>
          page
            .getByRole("region", { name: "Contributed service (ordinary)", exact: true })
            .getByText("Only people who can edit this app can change these accounts.", {
              exact: true,
            })
            .waitFor(),
        );
        yield* browser.checkpoint(
          "Contributed and ordinary requirements have different member actions",
        );
        yield* browser.use("Open my contribution's menu", (page) =>
          page.getByRole("button", { name: "Manage My service account", exact: true }).click(),
        );
        yield* browser.use("Remove the contribution I added", (page) =>
          page.getByRole("menuitem", { name: "Unlink", exact: true }).click(),
        );
        yield* browser.use("Keep the saved account", (page) =>
          page.getByRole("button", { name: "Keep account", exact: true }).click(),
        );
        yield* browser.use("My account remains as an unlinked choice", (page) =>
          page
            .getByRole("region", { name: "Contributed service (shared)", exact: true })
            .getByRole("checkbox", { name: "My service account", checked: false, exact: true })
            .waitFor(),
        );
        expect((yield* f.readLinks()).map((link) => link.account.id)).not.toContain(own);
        yield* ok(yield* f.link(actors.member, "shared", own));
        yield* browser.login(actors.owner);
        yield* browser.use("Open the editor's Accounts tab", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${f.app.id}?view=accounts`),
        );
        yield* browser.use("Editors see another member's contribution", (page) =>
          page.getByRole("checkbox", { name: "My service account", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Editors may remove another member's contribution", (page) =>
            page.getByRole("checkbox", { name: "My service account", exact: true }).isEnabled(),
          ),
        ).toBe(true);
      }),
    ),
  );
});
