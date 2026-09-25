/** Invitation capability secrecy through the native Better Auth HTTP routes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const Invitation = Schema.Struct({ id: Schema.String, email: Schema.String, role: Schema.String });
layer(HostedLive, { excludeTestServices: true })("Invitation privacy", (it) => {
  it.effect(scenarios.invitationPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organizationId = actors.organization.id;
        const created = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/organization/invite-member",
          {
            organizationId,
            email: "pending-admin@example.test",
            role: "admin",
          },
        );
        expect(created.status).toBe(200);
        const invitation = yield* body(Invitation, created);
        const list = `/api/auth/organization/list-invitations?organizationId=${organizationId}`;
        const full = `/api/auth/organization/get-full-organization?organizationId=${organizationId}`;
        for (const administrator of [actors.owner, actors.admin]) {
          const listed = yield* api.request(administrator, "GET", list);
          expect(listed.status).toBe(200);
          expect(
            (yield* body(Schema.Array(Invitation), listed)).map((value) => value.id),
          ).toContain(invitation.id);
          const organization = yield* api.request(administrator, "GET", full);
          expect(organization.status).toBe(200);
          expect(
            (yield* body(
              Schema.Struct({ invitations: Schema.Array(Invitation) }),
              organization,
            )).invitations.map((value) => value.id),
          ).toContain(invitation.id);
        }
        const browser = yield* Browser;
        yield* browser.login(actors.member);
        let invitationReads = 0;
        yield* browser.use("Watch the member's invitation requests", (page) => {
          page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/api/auth/organization/list-invitations")
              invitationReads += 1;
          });
          return Promise.resolve();
        });
        yield* browser.use("Open member settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("Member roster remains available", (page) =>
          page.getByRole("table", { name: "Members", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Only joined members appear", (page) =>
            page.locator(".membership-table tbody tr").count(),
          ),
        ).toBe(3);
        expect(invitationReads).toBe(0);
        yield* browser.checkpoint("Member settings without invitation secrets");
        yield* browser.login(actors.admin);
        yield* browser.use("Open administrator settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("Administrator sees the pending invitation", (page) =>
          page.getByRole("cell", { name: invitation.email, exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Administrator invitation management");
        const memberList = yield* api.request(actors.member, "GET", list);
        expect(memberList.status).toBe(403);
        expect((yield* api.request(actors.member, "GET", full)).status).toBe(403);
        // The member roster must remain usable without fetching invitation capabilities.
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `/api/auth/organization/list-members?organizationId=${organizationId}`,
          )).status,
        ).toBe(200);
        const anonymous = yield* api.session();
        for (const path of [list, full]) {
          expect((yield* api.request(anonymous, "GET", path)).status).toBe(401);
          expect(
            (yield* api.request(
              actors.member,
              "GET",
              path.replace(organizationId, "foreign-organization"),
            )).status,
          ).toBe(403);
        }
        for (const path of [
          `/api/auth/organization/get-invitation?id=${invitation.id}`,
          `/api/auth/organization/list-user-invitations?email=${invitation.email}`,
          `/api/auth/organization/get-organization?organizationId=${organizationId}`,
        ])
          expect((yield* api.request(actors.member, "GET", path)).status).toBe(404);
        for (const role of ["owner", "admin, owner", ["admin", "owner"]]) {
          expect(
            (yield* api.request(actors.admin, "POST", "/api/auth/organization/invite-member", {
              organizationId,
              email: "invalid-role@example.test",
              role,
            })).status,
          ).toBe(400);
        }
        expect(
          (yield* api.request(actors.member, "POST", "/api/auth/organization/cancel-invitation", {
            invitationId: invitation.id,
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.admin, "POST", "/api/auth/organization/cancel-invitation", {
            invitationId: invitation.id,
          })).status,
        ).toBe(200);

        const administrator = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.admin, "GET", "/api/viewer"),
        );
        const roster = yield* body(
          Schema.Struct({
            members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
          }),
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${organizationId}`,
          ),
        );
        const membership = roster.members.find((member) => member.userId === administrator.userId);
        expect(membership).toBeDefined();
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
            organizationId,
            memberId: membership?.id,
            role: "member",
          })).status,
        ).toBe(200);
        // Existing sessions lose invitation access as soon as membership changes.
        for (const path of [list, full])
          expect((yield* api.request(actors.admin, "GET", path)).status).toBe(403);
      }),
    ),
  );
});
