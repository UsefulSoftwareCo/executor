/** Persisted groups are exercised only through hosted HTTP and browser boundaries. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { Organization } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Group = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  name: Schema.String,
  description: Schema.String,
  memberIds: Schema.Array(Schema.String),
});
const Groups = Schema.Struct({
  groups: Schema.Array(Group),
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      userId: Schema.String,
      name: Schema.String,
      email: Schema.String,
    }),
  ),
  canManage: Schema.Boolean,
});

layer(HostedLive, { excludeTestServices: true })("Organization groups", (it) => {
  it.effect(scenarios.groupFormErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/groups`;
        const name = `Form ${randomUUID().slice(0, 8)}`;
        const existing = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", prefix, {
            name,
            description: "",
            memberIds: [],
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const groups = yield* body(Groups, yield* api.request(actors.owner, "GET", prefix));
            for (const group of groups.groups.filter(
              (item) => item.id === existing.id || item.name === `${name} corrected`,
            )) {
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/${group.id}`, {
                  revision: group.revision,
                })).status,
              ).toBe(200);
            }
          }).pipe(Effect.orDie),
        );
        const view = yield* body(Groups, yield* api.request(actors.owner, "GET", prefix));
        const member = view.members[0];
        if (!member) throw new Error("Expected a synthetic organization member");
        yield* browser.login(actors.owner);
        yield* browser.use("Open Groups", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups`),
        );
        yield* browser.use("Start duplicate group creation", (page) =>
          page.getByRole("button", { name: "Create group", exact: true }).click(),
        );
        yield* browser.use("Enter an existing name", (page) =>
          page.getByLabel("Group name", { exact: true }).fill(name),
        );
        yield* browser.use("Enter the description draft", (page) =>
          page.getByLabel("Description", { exact: false }).fill("Keep this draft"),
        );
        yield* browser.use("Select a member", (page) =>
          page.getByRole("checkbox", { name: `Include ${member.email}`, exact: true }).check(),
        );
        yield* browser.use("Submit the duplicate", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create group", exact: true })
            .click(),
        );
        yield* browser.use("Wait for duplicate error", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "A group with this name already exists" })
            .waitFor(),
        );
        expect(
          yield* browser.use("Duplicate is attached to the name field", (page) =>
            page.getByLabel("Group name", { exact: true }).getAttribute("aria-invalid"),
          ),
        ).toBe("true");
        expect(
          yield* browser.use("Focus returns to the invalid name", (page) =>
            page
              .getByLabel("Group name", { exact: true })
              .evaluate((input) => input === document.activeElement),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("Name error is described accessibly", (page) =>
            page.getByLabel("Group name", { exact: true }).getAttribute("aria-describedby"),
          ),
        ).toBeTruthy();
        yield* browser.checkpoint("Duplicate name has a focused red field error");
        yield* browser.use("Mobile duplicate error", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Mobile name error stays next to the input");
        yield* browser.use("Correct the name", (page) =>
          page.getByLabel("Group name", { exact: true }).fill(`${name} corrected`),
        );
        yield* browser.use("Interrupt the save request", (page) =>
          page.route("**/api/organizations/*/groups", (route) =>
            route.request().method() === "POST" ? route.abort("failed") : route.continue(),
          ),
        );
        yield* browser.use("Submit during a network failure", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create group", exact: true })
            .click(),
        );
        yield* browser.use("Wait for the network error", (page) =>
          page.getByRole("alert").filter({ hasText: "Could not reach the server" }).waitFor(),
        );
        expect(
          yield* browser.use("Transport failure receives focus", (page) =>
            page
              .getByRole("alert")
              .filter({ hasText: "Could not reach the server" })
              .evaluate((alert) => alert === document.activeElement),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("Description survives both failures", (page) =>
            page.getByLabel("Description", { exact: false }).inputValue(),
          ),
        ).toBe("Keep this draft");
        expect(
          yield* browser.use("Membership survives both failures", (page) =>
            page
              .getByRole("checkbox", { name: `Include ${member.email}`, exact: true })
              .isChecked(),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Mobile save failure is prominent and preserves the draft");
        yield* browser.use("Restore the connection", (page) =>
          page.unroute("**/api/organizations/*/groups"),
        );
        yield* browser.use("Retry the saved draft", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create group", exact: true })
            .click(),
        );
        yield* browser.use("Wait for successful creation", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        const after = yield* body(Groups, yield* api.request(actors.owner, "GET", prefix));
        const saved = after.groups.find((group) => group.name === `${name} corrected`);
        expect(saved?.description).toBe("Keep this draft");
        expect(saved?.memberIds).toEqual([member.id]);
      }),
    ),
  );

  it.effect(scenarios.groups.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/groups`;
        const name = `Engineering ${randomUUID().slice(0, 8)}`;
        let created: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (!created) return;
            const response = yield* api.request(actors.owner, "GET", `${prefix}/${created}`);
            if (response.status === 404) return;
            expect(response.status).toBe(200);
            const group = yield* body(Group, response);
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/${group.id}`, {
                revision: group.revision,
              })).status,
            ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", prefix)).status).toBe(401);
        const view = yield* body(Groups, yield* api.request(actors.owner, "GET", prefix));
        const memberIdentity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.member, "GET", "/api/viewer"),
        );
        const ownerIdentity = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.owner, "GET", "/api/viewer"),
        );
        const member = view.members.find((item) => item.userId === memberIdentity.userId);
        if (!member) throw new Error("Expected the synthetic member");
        const owner = view.members.find((item) => item.userId === ownerIdentity.userId);
        if (!owner) throw new Error("Expected the synthetic owner");
        yield* browser.login(actors.owner);
        yield* browser.use("Open Groups", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups`),
        );
        yield* browser.use("Start group creation", (page) =>
          page.getByRole("button", { name: "Create group", exact: true }).click(),
        );
        yield* browser.use("Name the group", (page) =>
          page.getByLabel("Group name", { exact: true }).fill(name),
        );
        yield* browser.use("Describe the group", (page) =>
          page.getByLabel("Description", { exact: false }).fill("Build and ship"),
        );
        yield* browser.use("Select an organization member", (page) =>
          page.getByRole("checkbox", { name: `Include ${member.email}`, exact: true }).check(),
        );
        yield* browser.use("Save the group", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create group", exact: true })
            .click(),
        );
        yield* browser.use("Creation completes", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        const afterCreate = yield* body(Groups, yield* api.request(actors.owner, "GET", prefix));
        const group = afterCreate.groups.find((item) => item.name === name);
        if (!group) throw new Error("Created group missing from persisted inventory");
        created = group.id;
        expect(group.memberIds).toEqual([member.id]);
        yield* browser.use("Reload persisted groups", (page) => page.reload());
        yield* browser.use("Saved group survives reload", (page) =>
          page.getByRole("heading", { name, exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open saved group", (page) =>
          page
            .getByRole("link")
            .filter({ has: page.getByRole("heading", { name, exact: true }) })
            .click(),
        );
        yield* browser.use("Edit group", (page) =>
          page.getByRole("button", { name: "Edit group", exact: true }).click(),
        );
        const renamed = `${name} updated`;
        yield* browser.use("Keep an unsaved name", (page) =>
          page.getByLabel("Group name", { exact: true }).fill(renamed),
        );
        const held = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (id) => `/api/organizations/${id}/groups`,
          ),
          "fail",
        );
        yield* refreshVisiblePage;
        yield* held.requested;
        yield* held.release;
        yield* browser.use("Background failure is visible", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Draft survives a failed refresh", (page) =>
            page.getByLabel("Group name", { exact: true }).inputValue(),
          ),
        ).toBe(renamed);
        yield* browser.checkpoint("Group edit survives a failed read");
        yield* browser.use("Add the owner", (page) =>
          page.getByRole("checkbox", { name: `Include ${owner.email}`, exact: true }).check(),
        );
        yield* browser.use("Save metadata and membership together", (page) =>
          page.getByRole("button", { name: "Save group", exact: true }).click(),
        );
        yield* browser.use("Edit completes", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        const saved = yield* body(
          Group,
          yield* api.request(actors.owner, "GET", `${prefix}/${group.id}`),
        );
        expect(saved.name).toBe(renamed);
        expect([...saved.memberIds].sort()).toEqual([member.id, owner.id].sort());
        expect(saved.revision).not.toBe(group.revision);
        yield* evidence.step(
          "Concurrent admins cannot create duplicate group names",
          Effect.gen(function* () {
            const concurrentName = `Concurrent ${randomUUID().slice(0, 8)}`;
            const responses = yield* Effect.all(
              [actors.owner, actors.admin].map((actor) =>
                api.request(actor, "POST", prefix, {
                  name: concurrentName,
                  description: "",
                  memberIds: view.members.map((item) => item.id),
                }),
              ),
              { concurrency: 2 },
            );
            for (const response of responses) {
              if (response.status !== 200) continue;
              const duplicate = yield* body(Group, response);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/${duplicate.id}`, {
                    revision: duplicate.revision,
                  })
                  .pipe(
                    Effect.tap((removed) => Effect.sync(() => expect(removed.status).toBe(200))),
                    Effect.orDie,
                  ),
              );
            }
            expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
          }),
        );
        yield* evidence.step(
          "Writes reject stale revisions and invalid memberships without partial changes",
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/${group.id}`, {
                name: "Stale overwrite",
                description: "",
                memberIds: [],
                revision: group.revision,
              })).status,
            ).toBe(409);
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/${group.id}`, {
                name: "Invalid membership",
                description: "",
                memberIds: [randomUUID()],
                revision: saved.revision,
              })).status,
            ).toBe(409);
            expect(
              yield* body(Group, yield* api.request(actors.owner, "GET", `${prefix}/${group.id}`)),
            ).toEqual(saved);
            expect(
              (yield* api.request(actors.owner, "POST", prefix, {
                name: renamed.toUpperCase(),
                description: "",
                memberIds: [],
              })).status,
            ).toBe(409);
          }),
        );
        yield* evidence.step(
          "Members may read but cannot create, change, or delete groups",
          Effect.gen(function* () {
            const listed = yield* body(Groups, yield* api.request(actors.member, "GET", prefix));
            expect(listed.canManage).toBe(false);
            expect(listed.groups.some((item) => item.id === group.id)).toBe(true);
            expect((yield* api.request(actors.member, "GET", `${prefix}/${group.id}`)).status).toBe(
              200,
            );
            expect(
              (yield* api.request(actors.member, "POST", prefix, {
                name: `${name} denied`,
                description: "",
                memberIds: [],
              })).status,
            ).toBe(403);
            expect(
              (yield* api.request(actors.member, "PATCH", `${prefix}/${group.id}`, {
                name: "Denied",
                description: "",
                memberIds: [],
                revision: saved.revision,
              })).status,
            ).toBe(403);
            expect(
              (yield* api.request(actors.member, "DELETE", `${prefix}/${group.id}`, {
                revision: saved.revision,
              })).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                actors.owner,
                "GET",
                `/api/organizations/${randomUUID()}/groups/${group.id}`,
              )).status,
            ).toBe(403);
            expect(
              yield* body(Group, yield* api.request(actors.owner, "GET", `${prefix}/${group.id}`)),
            ).toEqual(saved);
          }),
        );
        yield* browser.login(actors.member);
        yield* browser.use("Member opens the group", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups/${group.id}`),
        );
        yield* browser.use("Member sees the saved title", (page) =>
          page.getByRole("heading", { name: renamed, exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Member edit action explains its restriction", (page) =>
            page.getByRole("button", { name: "Edit group", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Member sees group membership with disabled management controls");
        yield* browser.login(actors.owner);
        yield* browser.use("Owner opens group for deletion", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups/${group.id}`),
        );
        yield* browser.use("Review group deletion", (page) =>
          page.getByRole("button", { name: "Delete group", exact: true }).click(),
        );
        yield* browser.use("Confirm group deletion", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Delete group", exact: true })
            .click(),
        );
        yield* browser.use("Deletion returns to directory", (page) =>
          page
            .getByRole("button", { name: "Create group", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect((yield* api.request(actors.owner, "GET", `${prefix}/${group.id}`)).status).toBe(404);
        const final = yield* body(Groups, yield* api.request(actors.owner, "GET", prefix));
        expect(final.members.map((item) => item.id).sort()).toEqual(
          view.members.map((item) => item.id).sort(),
        );
        created = undefined;
        yield* browser.checkpoint("Group deleted while organization members remain");
      }),
    ),
  );

  it.effect(scenarios.groupsIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const orgResponse = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/organization/create",
          {
            name: "Groups isolation",
            slug: `groups-${randomUUID().slice(0, 8)}`,
            keepCurrentActiveOrganization: true,
          },
        );
        expect(orgResponse.status).toBe(200);
        const other = yield* body(Organization, orgResponse);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `/api/organizations/${other.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const prefix = `/api/organizations/${actors.organization.id}/groups`;
        const created = yield* api.request(actors.owner, "POST", prefix, {
          name: `Isolation ${randomUUID().slice(0, 8)}`,
          description: "",
          memberIds: [],
        });
        expect(created.status).toBe(200);
        const group = yield* body(Group, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/${group.id}`, { revision: group.revision })
            .pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
        );
        const foreignPrefix = `/api/organizations/${other.id}/groups`;
        const foreign = yield* body(Groups, yield* api.request(actors.owner, "GET", foreignPrefix));
        expect(foreign.groups).toEqual([]);
        const foreignMember = foreign.members[0];
        if (!foreignMember) throw new Error("Second organization has no owner membership");
        expect(
          (yield* api.request(actors.owner, "GET", `${foreignPrefix}/${group.id}`)).status,
        ).toBe(404);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${foreignPrefix}/${group.id}`, {
            ...group,
            memberIds: [],
          })).status,
        ).toBe(404);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${foreignPrefix}/${group.id}`, {
            revision: group.revision,
          })).status,
        ).toBe(404);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/${group.id}`, {
            ...group,
            memberIds: [foreignMember.id],
          })).status,
        ).toBe(409);
        expect(
          yield* body(Group, yield* api.request(actors.owner, "GET", `${prefix}/${group.id}`)),
        ).toEqual(group);
        expect((yield* api.request(actors.member, "GET", foreignPrefix)).status).toBe(403);
      }),
    ),
  );
});
