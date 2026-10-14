/** Each member's app account links, through the actual hosted API and connection completion. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { App, Inventory, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  AccountLink,
  accountLinks,
  connectionsPath,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
  requirementPath,
  unlinkAccount,
  unlinkAccountResponse,
} from "../support/app-accounts.ts";
import {
  Access,
  who,
  appAccountsFixture,
  appAccountsMigration,
  appAccountsSource,
  sharedAccountFixture,
} from "../support/hosted-app-accounts.ts";
import { scenarios } from "../test-plan.ts";
import { McpClient } from "../support/mcp-client.ts";

const Failure = Schema.Struct({ _tag: Schema.String });
const AccountDetail = Schema.Struct({ account: Resource });
/** One requirement as `GET .../accounts/{scope}/:requirement` returns it. */
const Requirement = Schema.Struct({
  requirement: Schema.String,
  scope: Schema.String,
  provider: Schema.String,
  cardinality: Schema.String,
  accounts: Schema.Array(
    Schema.Struct({ account: Schema.Struct({ id: Schema.String }), linked: Schema.Boolean }),
  ),
});

/**
 * AccountChoiceUnsupported as the MCP skills tool returns it for a read naming accounts: its code
 * and status lead, as in an uncaught `execute` refusal.
 */
const accountChoiceUnsupported =
  "AccountChoiceUnsupported (HTTP 400): Accounts are not chosen per call. Each app uses the accounts you linked to it: one for each plain requirement, and every linked account for a many() requirement. Recovery: Call again without choosing accounts. Change the app's accounts in its Accounts tab. Retryable (unchanged call): no.";

layer(HostedLive, { excludeTestServices: true })("Hosted app accounts", (it) => {
  it.effect(scenarios.hostedAppAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, app, path, mailA, mailB, call, inventoryLinks } =
          yield* appAccountsFixture;
        const browser = yield* Browser;
        const skillPath = `${path}/skills/selected-account`;
        // Each member's links are their own: the inventory and the app's Accounts list show only
        // the caller's links, and the owner, who linked nothing, has none.
        expect(yield* inventoryLinks(actors.member)).toEqual([mailA]);
        expect(yield* inventoryLinks(actors.admin)).toEqual([mailB]);
        expect(yield* inventoryLinks(actors.owner)).toEqual([]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([mailA]);
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([mailB]);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([]);

        // Skills read with the caller's own linked account.
        const memberSkill = yield* api.request(actors.member, "GET", skillPath);
        expect(memberSkill.status, JSON.stringify(memberSkill.body)).toBe(200);
        expect(memberSkill.body).toMatchObject({ content: expect.stringContaining(mailA) });
        const adminSkill = yield* api.request(actors.admin, "GET", skillPath);
        expect(adminSkill.status, JSON.stringify(adminSkill.body)).toBe(200);
        expect(adminSkill.body).toMatchObject({ content: expect.stringContaining(mailB) });
        yield* browser.login(actors.member);
        yield* browser.use("Read the app's skills", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=skills`),
        );
        yield* browser.use("The linked account determines the instructions", (page) =>
          page.getByText(mailA, { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Skills use the member's linked account");

        // Calls run with the caller's own linked accounts. Each connection linked its account to
        // `service` only, so the many() `extra` requirement, which shares the provider, has none.
        expect(yield* accountLinks(actors.member, path)).toEqual([["service", mailA]]);
        expect(yield* who(yield* call(actors.member))).toEqual({
          context: { auth: false, profile: false },
          account: mailA,
          extra: [],
        });
        expect(yield* who(yield* call(actors.admin))).toEqual({
          context: { auth: false, profile: false },
          account: mailB,
          extra: [],
        });
        const ownerCall = yield* call(actors.owner);
        expect(ownerCall.status, JSON.stringify(ownerCall.body)).toBe(409);
        expect((yield* body(Failure, ownerCall))._tag).toBe("AccountRequired");
        expect(
          (yield* api.request(actors.member, "POST", `${path}/tools/call`, {
            deployment: "dpl_missing_opened_version",
            tool: "who",
            kind: "query",
            input: {},
          })).status,
        ).toBe(404);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${path}/tools?deployment=dpl_missing_opened_version`,
          )).status,
        ).toBe(404);
        expect((yield* api.request(actors.member, "GET", path)).body).not.toHaveProperty(
          "accounts",
        );
        // A member cannot link another member's personal account, so their calls never use it.
        yield* Effect.forEach(
          [
            [actors.member, mailB],
            [actors.admin, mailA],
            [actors.owner, mailA],
          ] as const,
          ([actor, other]) =>
            Effect.gen(function* () {
              expect((yield* linkAccountResponse(actor, path, "service", other)).status).toBe(403);
            }),
          { concurrency: 3, discard: true },
        );
        expect(yield* inventoryLinks(actors.member)).toEqual([mailA]);
        expect(yield* inventoryLinks(actors.admin)).toEqual([mailB]);
        expect(yield* inventoryLinks(actors.owner)).toEqual([]);
        expect(yield* who(yield* call(actors.member))).toMatchObject({ account: mailA });
        expect(yield* who(yield* call(actors.admin))).toMatchObject({ account: mailB });
        expect((yield* call(actors.owner)).status).toBe(409);

        // Unlinking keeps the saved account; calls need it linked again, and relinking restores
        // them with the same account.
        yield* unlinkAccount(actors.member, path, "service", mailA);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        expect(yield* inventoryLinks(actors.member)).toEqual([]);
        const unlinked = yield* call(actors.member);
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(409);
        expect((yield* body(Failure, unlinked))._tag).toBe("AccountRequired");
        const kept = yield* api.request(actors.member, "GET", `${prefix}/accounts/${mailA}`);
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        expect((yield* body(AccountDetail, kept)).account.id).toBe(mailA);
        yield* linkAccount(actors.member, path, "service", mailA);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: mailA,
          extra: [],
        });
        // Bob's link was never affected.
        expect(yield* who(yield* call(actors.admin))).toMatchObject({ account: mailB });
      }),
    ),
  );
  it.effect(scenarios.hostedAppAccountRoutes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, path, mailA, mailB, connect, call } =
          yield* appAccountsFixture;
        // Bob connects a shared account from the app for the many() `extra` requirement. The
        // connection links it there only: his `service` link keeps his personal account.
        const shared = yield* connect(actors.admin, "Shared mail", {
          shared: true,
          requirement: "extra",
        });
        expect(yield* accountLinks(actors.admin, path)).toEqual([
          ["extra", shared],
          ["service", mailB],
        ]);
        // Linking returns the link, and linking it again changes nothing.
        for (let attempt = 0; attempt < 2; attempt++) {
          const linked = yield* linkAccountResponse(actors.member, path, "extra", shared);
          expect(linked.status, JSON.stringify(linked.body)).toBe(200);
          expect(yield* body(AccountLink, linked)).toMatchObject({
            requirement: "extra",
            account: { id: shared, label: "Shared mail" },
          });
        }
        // The list names each link's requirement: by requirement, then oldest link first.
        const listed = yield* api.request(actors.member, "GET", `${path}/accounts/user`);
        expect(listed.status).toBe(200);
        expect(
          (yield* body(Schema.Array(AccountLink), listed)).map((link) => [
            link.requirement,
            link.account.id,
            link.account.label,
          ]),
        ).toEqual([
          ["extra", shared, "Shared mail"],
          ["service", mailA, "Alice mail"],
        ]);
        // Unlinking returns the link, and the account stays saved and usable for the organization.
        const unlinked = yield* unlinkAccountResponse(actors.member, path, "extra", shared);
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
        expect(unlinked.body).toEqual({ requirement: "extra", account: shared });
        expect(yield* accountLinks(actors.member, path)).toEqual([["service", mailA]]);
        const second = yield* unlinkAccountResponse(actors.member, path, "extra", shared);
        expect(second.status, JSON.stringify(second.body)).toBe(404);
        expect((yield* body(Failure, second))._tag).toBe("AccountNotFound");
        const kept = yield* api.request(actors.member, "GET", `${prefix}/accounts/${shared}`);
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        expect((yield* body(AccountDetail, kept)).account.id).toBe(shared);
        expect(
          (yield* body(
            Inventory,
            yield* api.request(actors.member, "GET", `${prefix}/inventory`),
          )).accounts.map((account) => account.id),
        ).toContain(shared);
        // Bob's link to his shared account is unaffected by Alice unlinking it.
        expect(yield* accountLinks(actors.admin, path)).toEqual([
          ["extra", shared],
          ["service", mailB],
        ]);
        // Links are keyed by requirement, even where two share a provider. Linking to many()
        // adds; linking to the plain requirement replaces its account, which stays linked to
        // `extra`.
        yield* linkAccount(actors.member, path, "extra", mailA);
        yield* linkAccount(actors.member, path, "extra", shared);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: mailA,
          extra: [mailA, shared],
        });
        yield* linkAccount(actors.member, path, "service", shared);
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", mailA],
          ["extra", shared],
          ["service", shared],
        ]);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: shared,
          extra: [mailA, shared],
        });

        // One requirement lists its linked accounts first, marked, then the caller's other usable
        // accounts of its provider. Alice never sees Bob's personal account, nor Bob hers.
        const requirement = (actor: typeof actors.member, name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "GET", requirementPath(path, "user", name));
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const decoded = yield* body(Requirement, response);
            return {
              ...decoded,
              accounts: decoded.accounts.map((item) => [item.account.id, item.linked]),
            };
          });
        const provider = (yield* body(
          Schema.Array(AccountLink),
          yield* api.request(actors.member, "GET", `${path}/accounts/user`),
        ))[0]?.account.provider;
        expect(provider).toBeDefined();
        expect(yield* requirement(actors.member, "service")).toEqual({
          requirement: "service",
          scope: "user",
          provider,
          cardinality: "one",
          accounts: [
            [shared, true],
            [mailA, false],
          ],
        });
        expect(yield* requirement(actors.member, "extra")).toEqual({
          requirement: "extra",
          scope: "user",
          provider,
          cardinality: "many",
          accounts: [
            [mailA, true],
            [shared, true],
          ],
        });
        expect(yield* requirement(actors.admin, "service")).toMatchObject({
          cardinality: "one",
          accounts: [
            [mailB, true],
            [shared, false],
          ],
        });

        // A requirement the app does not declare in that scope cannot be read or linked.
        const unknownRequirement = (scope: "app" | "user", name: string) => ({
          _tag: "RequirementMismatch",
          requirement: name,
          scope,
          reason: "requirement",
        });
        const unknownRead = yield* api.request(
          actors.member,
          "GET",
          requirementPath(path, "user", "missing"),
        );
        expect(unknownRead.status, JSON.stringify(unknownRead.body)).toBe(422);
        expect(unknownRead.body).toMatchObject(unknownRequirement("user", "missing"));
        const unknownLink = yield* linkAccountResponse(actors.member, path, "missing", mailA);
        expect(unknownLink.status, JSON.stringify(unknownLink.body)).toBe(422);
        expect(unknownLink.body).toMatchObject(unknownRequirement("user", "missing"));
        // `service` is a user requirement: Bob, who can edit the app, cannot link it for everyone.
        const wrongScope = yield* linkAccountResponse(actors.admin, path, "service", shared, "app");
        expect(wrongScope.status, JSON.stringify(wrongScope.body)).toBe(422);
        expect(wrongScope.body).toMatchObject(unknownRequirement("app", "service"));
        expect(yield* accountLinks(actors.admin, path, "app")).toEqual([]);
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", mailA],
          ["extra", shared],
          ["service", shared],
        ]);

        // An account of another provider cannot be linked to the requirement.
        const other = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Other provider ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, object, string } from "apps";
const other = defineProvider({ name: "Other provider fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { other } } }, {});`,
            },
            appsManifest,
          ],
        });
        expect(other.status, JSON.stringify(other.body)).toBe(200);
        const otherPath = `${prefix}/apps/${(yield* body(App, other)).id}`;
        const otherAccounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", otherPath);
            for (const account of otherAccounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const pending = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(otherPath, "user", "other"),
          { destination: { kind: "shared", audience: { kind: "everyone" } } },
        );
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const submitted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
          { method: "key", label: "Other account", fields: { token: "synthetic-other" } },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const otherAccount = (yield* body(Resource, submitted)).id;
        otherAccounts.push(otherAccount);
        const mismatch = yield* linkAccountResponse(actors.member, path, "service", otherAccount);
        expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(422);
        expect(mismatch.body).toMatchObject({
          _tag: "RequirementMismatch",
          requirement: "service",
          scope: "user",
          reason: "provider",
        });
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", mailA],
          ["extra", shared],
          ["service", shared],
        ]);

        // A member cannot link an account they cannot use: Bob's personal account, or a shared
        // account whose audience excludes them.
        const personal = yield* linkAccountResponse(actors.member, path, "service", mailB);
        expect(personal.status, JSON.stringify(personal.body)).toBe(403);
        const sharedAccess = `${prefix}/accounts/${shared}/access`;
        const current = yield* body(Access, yield* api.request(actors.admin, "GET", sharedAccess));
        expect(
          (yield* api.request(actors.admin, "PATCH", sharedAccess, {
            revision: current.revision,
            audience: { kind: "groups", groups: [] },
          })).status,
        ).toBe(200);
        yield* unlinkAccount(actors.member, path, "extra", shared);
        yield* unlinkAccount(actors.member, path, "service", shared);
        const revoked = yield* linkAccountResponse(actors.member, path, "extra", shared);
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(403);
        expect(yield* accountLinks(actors.member, path)).toEqual([["extra", mailA]]);
      }),
    ),
  );
  it.effect(scenarios.hostedManyAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, path, mailA, mailB, shared, connect, call } =
          yield* sharedAccountFixture;
        const skill = (actor: typeof actors.member) =>
          api.request(actor, "GET", `${path}/skills/selected-account`);
        // `service` and `extra: service.many()` share a provider, yet each has its own links:
        // Alice links the shared account to `service`, and her personal and the shared one to
        // `extra`.
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", mailA],
          ["extra", shared],
          ["service", shared],
        ]);
        // many() receives every linked account in link order; the plain requirement its one link.
        expect(yield* who(yield* call(actors.member))).toEqual({
          context: { auth: false, profile: false },
          account: shared,
          extra: [mailA, shared],
        });
        // Reads that evaluate app code with the caller's accounts use the same accounts.
        const read = yield* skill(actors.member);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(read.body).toMatchObject({ content: expect.stringContaining(shared) });
        // A third account connected from the app for many() joins it, and only it.
        const third = yield* connect(actors.member, "Alice third mail", { requirement: "extra" });
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", mailA],
          ["extra", shared],
          ["extra", third],
          ["service", shared],
        ]);
        expect(yield* who(yield* call(actors.member))).toEqual({
          context: { auth: false, profile: false },
          account: shared,
          extra: [mailA, shared, third],
        });
        // Linking it to the plain requirement replaces that requirement's account; many() keeps
        // every link.
        yield* linkAccount(actors.member, path, "service", third);
        expect(yield* who(yield* call(actors.member))).toEqual({
          context: { auth: false, profile: false },
          account: third,
          extra: [mailA, shared, third],
        });
        const replaced = yield* skill(actors.member);
        expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
        expect(replaced.body).toMatchObject({ content: expect.stringContaining(third) });
        // Unlinking one from many() leaves the rest for later calls, still in link order.
        yield* unlinkAccount(actors.member, path, "extra", shared);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: third,
          extra: [mailA, third],
        });
        yield* unlinkAccount(actors.member, path, "extra", third);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: third,
          extra: [mailA],
        });
        // Linking again makes an account many()'s newest link once more, and replaces the plain
        // requirement's account again.
        yield* linkAccount(actors.member, path, "extra", shared);
        yield* linkAccount(actors.member, path, "service", shared);
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", mailA],
          ["extra", shared],
          ["service", shared],
        ]);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: shared,
          extra: [mailA, shared],
        });
        // The plain requirement uses only its own link: unlinked, nothing is taken from many()'s
        // links of the same provider.
        yield* unlinkAccount(actors.member, path, "service", shared);
        const missing = yield* call(actors.member);
        expect(missing.status, JSON.stringify(missing.body)).toBe(409);
        expect(missing.body).toMatchObject({ _tag: "AccountRequired", slot: "service" });
        yield* linkAccount(actors.member, path, "service", shared);
        // Accounts unlinked from the app stay saved, and Bob's own links were never affected.
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${third}`)).status,
        ).toBe(200);
        expect(yield* accountLinks(actors.admin, path)).toEqual([
          ["extra", mailB],
          ["extra", shared],
          ["service", shared],
        ]);
        expect(yield* who(yield* call(actors.admin))).toMatchObject({
          account: shared,
          extra: [mailB, shared],
        });
      }),
    ),
  );
  it.effect(scenarios.hostedAppAccountRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, path, mailA, mailB, call, inventoryLinks, shared } =
          yield* sharedAccountFixture;
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: shared,
          extra: [mailA, shared],
        });
        // Deleting Alice's own account drops it from her links; nothing is substituted.
        expect(
          (yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${mailA}`)).status,
        ).toBe(200);
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["extra", shared],
          ["service", shared],
        ]);
        expect(yield* who(yield* call(actors.member))).toMatchObject({
          account: shared,
          extra: [shared],
        });
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([mailB, shared]);
        // Revoking Alice's access to the shared account removes it from her calls at use time.
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
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        expect(yield* inventoryLinks(actors.member)).toEqual([]);
        const revoked = yield* call(actors.member);
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(409);
        expect((yield* body(Failure, revoked))._tag).toBe("AccountRequired");
        const revokedSkill = yield* api.request(
          actors.member,
          "GET",
          `${path}/skills/selected-account`,
        );
        expect(revokedSkill.status, JSON.stringify(revokedSkill.body)).toBe(409);
        expect((yield* body(Failure, revokedSkill))._tag).toBe("AccountRequired");
        expect((yield* linkAccountResponse(actors.member, path, "service", shared)).status).toBe(
          403,
        );
        // No group remains in the audience, so the account drops out of Bob's links as well.
        // Nothing is substituted for his plain requirement: his personal account, still linked to
        // `extra`, serves `service` only once he links it there again.
        expect(yield* accountLinks(actors.admin, path)).toEqual([["extra", mailB]]);
        const bobRevoked = yield* call(actors.admin);
        expect(bobRevoked.status, JSON.stringify(bobRevoked.body)).toBe(409);
        expect((yield* body(Failure, bobRevoked))._tag).toBe("AccountRequired");
        yield* linkAccount(actors.admin, path, "service", mailB);
        expect(yield* who(yield* call(actors.admin))).toMatchObject({
          account: mailB,
          extra: [mailB],
        });
        // Making the app private stops Alice's calls and removes it from her inventory.
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
        expect((yield* call(actors.member)).status).toBe(403);
        expect(yield* inventoryLinks(actors.member)).toEqual([]);
        expect(
          (yield* api.request(actors.member, "GET", `${path}/skills/selected-account`)).status,
        ).toBe(403);
        // Alice can still clean up her own links after losing access.
        yield* unlinkAccount(actors.member, path, "service", shared);
        yield* unlinkAccount(actors.member, path, "extra", shared);
      }),
    ),
  );
  it.effect(scenarios.hostedSkillAccountChoice.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, app, path, mailA, connect } = yield* appAccountsFixture;
        const mcp = yield* McpClient;
        // Alice connects a second account for the plain requirement the skill's text depends on,
        // which replaces her first there.
        const second = yield* connect(actors.member, "Alice second mail");
        expect(yield* accountLinks(actors.member, path)).toEqual([["service", second]]);
        const issued = yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
          name: "Skill accounts",
        });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
        const key = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          issued,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "skill-accounts", {
          organization: actors.organization.id,
        });
        const skills = (step: string, input: Record<string, unknown>) =>
          client.use(step, (client, signal) =>
            client.callTool({ name: "skills", arguments: input }, undefined, { signal }),
          );
        const named = { app: app.slug, name: "selected-account" };
        // The read uses the plain requirement's link, as a tool call does.
        const read = yield* skills("Read with the linked accounts", named);
        expect(read.isError, JSON.stringify(read)).not.toBe(true);
        expect(read.structuredContent).toMatchObject({
          content: expect.stringContaining(second),
        });
        expect(JSON.stringify(read.structuredContent)).not.toContain(mailA);
        // Reads never choose accounts: naming them is refused, for a document or a listing.
        for (const [step, input] of [
          ["Read a skill naming an account", { ...named, accounts: { service: mailA } }],
          [
            "List the app's skills naming an account",
            { app: app.slug, accounts: { service: [mailA] } },
          ],
        ] as const) {
          const refused = yield* skills(step, input);
          expect(refused.isError, JSON.stringify(refused)).toBe(true);
          // The skills tool's error text names AccountChoiceUnsupported's code and status.
          expect(refused.content).toEqual([{ type: "text", text: accountChoiceUnsupported }]);
        }
        const listed = yield* skills("List the app's skills", { app: app.slug });
        expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
        expect(listed.structuredContent).toMatchObject({
          skills: [expect.objectContaining({ name: "selected-account" })],
        });
        // The full index reads the app with the same linked accounts.
        const index = yield* skills("List every app's skills", {});
        const result = Schema.decodeUnknownSync(
          Schema.Struct({
            skills: Schema.Array(Schema.Struct({ app: Schema.Struct({ id: Schema.String }) })),
            unavailableApps: Schema.optional(
              Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
            ),
          }),
        )(index.structuredContent);
        expect(result.skills.some((skill) => skill.app.id === app.id)).toBe(true);
        expect(result.unavailableApps?.some((item) => item.app === app.id) ?? false).toBe(false);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.hostedHistoricalSkillAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, app, path, mailA, connect } = yield* appAccountsFixture;
        const mcp = yield* McpClient;
        const SkillRead = Schema.Struct({ deployment: Schema.String, content: Schema.String });
        const read = (query: string) =>
          api.request(actors.member, "GET", `${path}/skills/selected-account${query}`);
        const first = yield* body(SkillRead, yield* read(""));
        expect(first.content).toContain(mailA);
        // A newer deployment renames the requirement the skill's text depends on.
        const renamed = appAccountsSource
          .replace("accounts: { service, extra:", "accounts: { mail: service, extra:")
          .replaceAll("accounts.service.", "accounts.mail.");
        const redeployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: renamed }, appAccountsMigration, appsManifest],
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        // Links name their requirement, so the renamed one has none until Alice links an account
        // to it: the current skill needs one.
        const unlinked = yield* read("");
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(409);
        expect(unlinked.body).toMatchObject({ _tag: "AccountRequired", slot: "mail" });
        const renamedMail = yield* connect(actors.member, "Alice renamed mail", {
          requirement: "mail",
        });
        const current = yield* body(SkillRead, yield* read(""));
        expect(current.deployment).not.toBe(first.deployment);
        expect(current.content).toContain(renamedMail);
        expect(current.content).not.toContain(mailA);
        // The earlier deployment's skill still reads with that deployment's own requirement, whose
        // link to mailA remains.
        const pinned = yield* read(`?deployment=${first.deployment}`);
        expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
        expect(yield* body(SkillRead, pinned)).toMatchObject({
          deployment: first.deployment,
          content: expect.stringContaining(mailA),
        });

        // MCP reads pinned to the earlier deployment resolve the same way.
        const issued = yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
          name: "Historical skill",
        });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
        const key = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          issued,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "historical-skill", {
          organization: actors.organization.id,
        });
        const viaMcp = yield* client.use("Read the earlier deployment's skill", (client, signal) =>
          client.callTool(
            {
              name: "skills",
              arguments: { app: app.slug, name: "selected-account", deployment: first.deployment },
            },
            undefined,
            { signal },
          ),
        );
        expect(viaMcp.isError, JSON.stringify(viaMcp)).not.toBe(true);
        expect(viaMcp.structuredContent).toMatchObject({
          deployment: first.deployment,
          content: expect.stringContaining(mailA),
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
