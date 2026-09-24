/** Personal profile authority through the actual hosted API and connection completion. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { scenarios } from "../test-plan.ts";
import {
  Profile,
  Access,
  profileFixture,
  sharedProfileFixture,
} from "../support/hosted-profile.ts";
layer(HostedLive, { excludeTestServices: true })("Hosted profiles", (it) => {
  it.effect(scenarios.hostedProfiles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* profileFixture;
        const { api, actors, app, path, mailA, mailB, bob, call } = fixture;
        let { alice } = fixture;
        const browser = yield* Browser;
        const skillPath = `${path}/skills/selected-account`;
        const selectedSkill = yield* api.request(
          actors.member,
          "GET",
          `${path}/skills/selected-account?profile=${alice.id}`,
        );
        expect(selectedSkill.status).toBe(200);
        yield* browser.login(actors.member);
        yield* browser.use("Read skills with the selected profile", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=skills&profile=${alice.id}`,
          ),
        );
        yield* browser.use("The profile's account determines the instructions", (page) =>
          page.getByText(mailA, { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Skills use the selected personal profile");
        expect(selectedSkill.body).toMatchObject({
          profile: alice.id,
          profileRevision: alice.revision,
          content: expect.stringContaining(mailA),
        });
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${skillPath}?profile=${alice.id}&expectedProfileRevision=${alice.revision + 1}`,
          )).status,
        ).toBe(409);
        expect((yield* api.request(actors.member, "GET", skillPath)).status).toBe(409);
        expect((yield* call(actors.member, alice.id)).body).toMatchObject({
          context: { auth: false, profile: false },
          account: mailA,
          extra: [],
        });
        expect(
          (yield* api.request(actors.member, "POST", `${path}/tools/call`, {
            profile: alice.id,
            deployment: "dpl_missing_opened_version",
            tool: "queries.who",
            input: {},
          })).status,
        ).toBe(404);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${path}/tools?profile=${alice.id}&deployment=dpl_missing_opened_version`,
          )).status,
        ).toBe(404);
        expect((yield* call(actors.admin, bob.id)).body).toMatchObject({
          context: { auth: false, profile: false },
          account: mailB,
          extra: [],
        });
        expect((yield* api.request(actors.member, "GET", path)).body).not.toHaveProperty(
          "accounts",
        );
        yield* Effect.forEach(
          [
            [actors.member, bob.id],
            [actors.admin, alice.id],
            [actors.owner, alice.id],
          ] as const,
          ([actor, other]) =>
            Effect.gen(function* () {
              expect((yield* call(actor, other)).status).toBe(403);
              expect(
                (yield* api.request(actor, "GET", `${skillPath}?profile=${other}`)).status,
              ).toBe(403);
              expect((yield* api.request(actor, "GET", `${path}/profiles/${other}`)).status).toBe(
                403,
              );
              expect(
                (yield* api.request(actor, "DELETE", `${path}/profiles/${other}`)).status,
              ).toBe(403);
              expect(
                (yield* api.request(actor, "PATCH", `${path}/profiles/${other}/enabled`, {
                  expectedRevision: 1,
                  enabled: false,
                })).status,
              ).toBe(403);
              expect(
                (yield* api.request(actor, "POST", `${path}/connections`, {
                  profile: other,
                  requirement: "service",
                })).status,
              ).toBe(403);
            }),
          { concurrency: 3, discard: true },
        );
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/profiles/${alice.id}`, {
            expectedRevision: alice.revision,
            accounts: { service: mailB, extra: [] },
          })).status,
        ).toBe(403);
        const disabled = yield* body(
          Profile,
          yield* api.request(actors.member, "PATCH", `${path}/profiles/${alice.id}/enabled`, {
            expectedRevision: alice.revision,
            enabled: false,
          }),
        );
        expect(disabled.enabled).toBe(false);
        expect(disabled.accounts).toEqual(alice.accounts);
        expect((yield* call(actors.member, alice.id)).status).toBe(409);
        alice = yield* body(
          Profile,
          yield* api.request(actors.member, "PATCH", `${path}/profiles/${alice.id}/enabled`, {
            expectedRevision: disabled.revision,
            enabled: true,
          }),
        );
        expect((yield* call(actors.member, alice.id)).status).toBe(200);
      }),
    ),
  );
  it.effect(scenarios.hostedProfileRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          prefix,
          path,
          mailA,
          bob,
          get,
          call,
          inventoryProfiles,
          alice,
          shared,
        } = yield* sharedProfileFixture;
        const beforeDelete = yield* get(actors.member, alice.id);
        expect(
          (yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${mailA}`)).status,
        ).toBe(200);
        const afterDelete = yield* get(actors.member, alice.id);
        expect(afterDelete.accounts.extra).toEqual([shared]);
        expect(afterDelete.revision).toBe(beforeDelete.revision + 1);
        expect((yield* get(actors.admin, bob.id)).accounts.service).toBe(shared);
        const sharedAccess = yield* body(
          Access,
          yield* api.request(actors.admin, "GET", `${prefix}/accounts/${shared}/access`),
        );
        expect(
          (yield* api.request(actors.admin, "PATCH", `${prefix}/accounts/${shared}/access`, {
            revision: sharedAccess.revision,
            audience: { kind: "groups", groups: [] },
          })).status,
        ).toBe(200);
        expect((yield* call(actors.member, alice.id)).status).toBe(403);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${path}/skills/selected-account?profile=${alice.id}`,
          )).status,
        ).toBe(403);
        const revoked = yield* get(actors.member, alice.id);
        const stopped = yield* body(
          Profile,
          yield* api.request(actors.member, "PATCH", `${path}/profiles/${alice.id}/enabled`, {
            expectedRevision: revoked.revision,
            enabled: false,
          }),
        );
        expect(stopped.enabled).toBe(false);
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/profiles/${alice.id}/enabled`, {
            expectedRevision: stopped.revision,
            enabled: true,
          })).status,
        ).toBe(403);
        const appAccess = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: appAccess.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        expect((yield* call(actors.member, alice.id)).status).toBe(403);
        expect(yield* inventoryProfiles(actors.member)).not.toContain(alice.id);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${path}/skills/selected-account?profile=${alice.id}`,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "DELETE", `${path}/profiles/${alice.id}`)).status,
        ).toBe(200);
      }),
    ),
  );
});
