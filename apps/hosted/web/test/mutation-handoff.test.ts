import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { after, beforeEach, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerBrowser } from "./dom.ts";
import { Effect, Option, Redacted, Schema } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AccountId,
  AppId,
  ProfileId,
  type Profile,
  AppSlug,
  AppCodeId,
  DeploymentId,
  OwnerId,
  ProviderId,
  AccountConnectionId,
  type Account,
  type App,
  type Provider,
  SelectedAccounts,
} from "@executor-js/sdk";
import { OrganizationId } from "@executor-js/hosted-server/organization";

const org = OrganizationId.make("org_fixture"),
  otherOrg = OrganizationId.make("org_other");
const appId = AppId.make("app_fixture"),
  accountId = AccountId.make("acc_fixture");
const provider: Provider = {
  id: ProviderId.make("prv_fixture"),
  definition: {
    name: "Fixture",
    auth: { key: { type: "secrets", label: "Key", fields: { type: "object" } } },
  },
};
const firstAccount: Account = {
  id: accountId,
  provider: provider.id,
  method: "key",
  label: "Original",
  owner: OwnerId.make("organization:org_fixture"),
  createdAt: new Date("2026-01-01"),
};
const firstApp: App = {
  id: appId,
  code: AppCodeId.make("code_fixture"),
  repository: null,
  copiedFrom: null,
  owner: firstAccount.owner,
  name: "Original app",
  slug: AppSlug.make("original-app"),
  activeDeployment: DeploymentId.make("dpl_one"),
  requirements: {
    accounts: {
      service: { provider: provider.id, definition: provider.definition, cardinality: "one" },
    },
  },
  createdAt: firstAccount.createdAt,
};
const firstProfile: Profile = {
  id: ProfileId.make("ins_fixture"),
  app: appId,
  owner: firstAccount.owner,
  subject: "user_fixture",
  name: null,
  accounts: { service: accountId },
  webhookConfig: {},
  revision: 1,
  enabled: true,
  status: "ready",
  failure: null,
  reconciledDeployment: firstApp.activeDeployment,
  reconciledRevision: 1,
  createdAt: firstAccount.createdAt,
};
let profile = firstProfile;
let account = firstAccount,
  app = firstApp,
  accountDeleted = false,
  appDeleted = false,
  rejectWrite = false,
  signedIn = false;
let members = [
  {
    id: "member_fixture",
    organizationId: org,
    userId: "user_fixture",
    role: "admin",
    createdAt: new Date("2026-01-01"),
    user: { id: "user_fixture", email: "fixture@example.test", name: "Fixture", image: null },
  },
];
let invitations: Array<{
  id: string;
  email: string;
  role: string;
  organizationId: string;
  inviterId: string;
  status: string;
  expiresAt: Date;
}> = [];
let holdReads = false,
  rejectReads = false;
const heldWrites: Array<() => void> = [];
const held: Array<() => void> = [];
const streams = new Set<ServerResponse>();
const release = () => {
  holdReads = false;
  for (const send of held.splice(0)) send();
};
const overview = () => ({
  apps: appDeleted ? [] : [app],
  accounts: accountDeleted ? [] : [localAccount()],
  profiles: appDeleted ? [] : [profile],
});
const localAccount = () => ({
  ...account,
  providerName: "Fixture",
  providerUrl: null,
  signIn: { state: "saved", reconnectAt: null },
});
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture").pathname;
  const send = (value: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const read = (value: () => unknown) => {
    const captured = value();
    const reply = () =>
      rejectReads ? send({ message: "Synthetic read unavailable" }, 503) : send(captured);
    if (holdReads) held.push(reply);
    else reply();
  };
  if (request.method === "GET") {
    if (path === "/api/auth/get-session")
      return read(() =>
        signedIn
          ? {
              user: {
                id: "user_fixture",
                name: "Fixture",
                email: "fixture@example.test",
                image: null,
              },
              session: { id: "session_fixture" },
            }
          : null,
      );
    if (path === "/api/auth/self-host/config") return send({ setup: false, sso: false });
    if (path.includes("list-members")) return read(() => ({ members, total: members.length }));
    if (path.includes("list-invitations")) return read(() => invitations);
    if (path.endsWith("/access"))
      return read(() => ({
        organization: org,
        owner: firstAccount.owner,
        role: members[0]?.role ?? "member",
      }));
    if (path.endsWith("/inventory"))
      return read(() => ({
        apps: appDeleted ? [] : [app],
        accounts: accountDeleted ? [] : [account],
        profiles: appDeleted ? [] : [profile],
        accountSetup: { redirectUri: `${origin}/api/oauth/callback` },
      }));
    if (path.includes("/dashboard/api/live/")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      streams.add(response);
      response.on("close", () => streams.delete(response));
      const data = path.endsWith("overview")
        ? overview()
        : path.includes("/accounts/")
          ? { account: localAccount(), provider, apps: appDeleted ? [] : [app], canManage: true }
          : path.endsWith("/tools")
            ? { tools: [] }
            : { app, deployments: [], canDelete: true, uiUrl: null };
      const emit = () =>
        response.write(
          `data: ${JSON.stringify({ type: "snapshot", revision: 1, value: data })}\n\n`,
        );
      if (holdReads) held.push(emit);
      else emit();
      return;
    }
    if (path.endsWith(`/apps/${appId}/tools`))
      return read(() => ({
        items: [
          {
            app: appId,
            deployment: app.activeDeployment,
            name: "fixture",
            description: "Fixture",
            inputSchema: { type: "object" },
          },
        ],
        deployment: app.activeDeployment,
        nextCursor: null,
      }));
    if (path.endsWith(`/apps/${appId}/profiles`)) return read(() => [profile]);
    if (path.endsWith(`/apps/${appId}`)) return read(() => app);
    if (path.endsWith(`/accounts/${accountId}`))
      return read(() => ({ account, provider, apps: appDeleted ? [] : [app], canManage: true }));
    if (path.endsWith("/connections/con_fixture"))
      return send({
        redirectUri: `${origin}/api/oauth/callback`,
        id: "con_fixture",
        owner: firstAccount.owner,
        provider,
        reconnectAccount: account,
        target: { app: appId, profile: profile.id, requirement: "service", name: app.name },
        createdAt: firstAccount.createdAt,
        expiresAt: new Date("2027-01-01"),
        state: { status: "pending" },
      });
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text
    ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
        text,
      )
    : {};
  if (rejectWrite) return send({ code: "FORBIDDEN" }, 403);
  if (
    path === "/api/auth/sign-in/email" ||
    path === "/api/auth/sign-in/email-otp" ||
    path === "/api/auth/self-host/setup"
  ) {
    signedIn = true;
    return send({ token: "fixture", user: { id: "user_fixture" } });
  }
  if (path.endsWith("update-member-role")) {
    members = members.map((member) => ({ ...member, role: String(body.role) }));
    return send(members[0]);
  }
  if (path.endsWith("remove-member")) {
    members = [];
    return send({ member: { id: "member_fixture" } });
  }
  if (path.endsWith("invite-member")) {
    const invite = {
      id: "inv_fixture",
      email: String(body.email),
      role: String(body.role),
      organizationId: org,
      inviterId: "user_fixture",
      status: "pending",
      expiresAt: new Date("2027-01-01"),
    };
    invitations = [invite];
    return send(invite);
  }
  if (path.endsWith("cancel-invitation")) {
    const invitation = invitations.find((invitation) => invitation.id === body.invitationId);
    if (!invitation) return send({ code: "INVITATION_NOT_FOUND" }, 400);
    const canceled = { ...invitation, status: "canceled" };
    invitations = invitations.map((item) => (item.id === canceled.id ? canceled : item));
    return send(canceled);
  }
  if (request.method === "DELETE" && path.endsWith(`/apps/${appId}`)) {
    appDeleted = true;
    return send({ app: appId });
  }
  if (request.method === "DELETE" && path.endsWith(`/accounts/${accountId}`)) {
    accountDeleted = true;
    return send({ account: accountId });
  }
  if (path.endsWith(`/accounts/${accountId}`) && request.method === "PATCH") {
    account = { ...account, label: String(body.label) };
    const saved = account;
    if (body.label === "Slow account") {
      heldWrites.push(() => send(saved));
      return;
    }
    return send(saved);
  }
  if (path.endsWith(`/apps/${appId}/name`)) {
    app = { ...app, name: String(body.name) };
    return send(app);
  }
  if (path.endsWith(`/apps/${appId}/profiles/${profile.id}`) && request.method === "PATCH") {
    assert.equal(body.expectedRevision, profile.revision);
    profile = {
      ...profile,
      revision: profile.revision + 1,
      accounts: Schema.decodeUnknownSync(SelectedAccounts)(body.accounts),
    };
    return send(profile);
  }
  if (path.endsWith(`/apps/${appId}/activate`)) {
    app = { ...app, activeDeployment: DeploymentId.make(String(body.deployment)) };
    return send(app);
  }
  if (path.endsWith("/connections/con_fixture/submit")) {
    profile = { ...profile, revision: profile.revision + 1, accounts: { service: accountId } };
    return send(account);
  }
  send({ message: `Unhandled ${request.method} ${path}` }, 404);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const fetch = globalThis.fetch;
registerBrowser(origin);
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: (input: string | URL | Request, init?: RequestInit) =>
    fetch(typeof input === "string" ? new URL(input, origin) : input, init),
});
const hosted = await import("../src/contracts/apps.ts");
const hostedAccounts = await import("../src/contracts/accounts.ts");
const organization = await import("../src/contracts/organization.ts");
const profiles = await import("../src/contracts/profiles.ts");
const local = await import("../../../local/web/src/contracts/api.ts");
const localApps = await import("../../../local/web/src/contracts/apps.ts");
const localAccounts = await import("../../../local/web/src/contracts/accounts.ts");
const localOnboarding = await import("../../../local/web/src/contracts/onboarding.ts");
const session = await import("../src/contracts/auth.ts");
const selfHostAuth = await import("../../self-host/web/src/contracts/auth.ts");
const cloudAuth = await import("../../cloud/web/src/contracts/auth.ts");
const key = { organization: org, app: appId },
  accountKey = { organization: org, account: accountId };
const value = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => Option.getOrThrow(AsyncResult.value(registry.get(atom)));
const read = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));
const mutate = <I, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<I, A, E>,
  input: I,
) => {
  registry.set(atom, input);
  return read(registry, atom);
};
const settle = async (ready: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ready() && Date.now() < end) await new Promise((done) => setTimeout(done, 5));
  assert.ok(ready());
};
beforeEach(() => {
  release();
  account = firstAccount;
  app = firstApp;
  profile = firstProfile;
  appDeleted = false;
  accountDeleted = false;
  rejectWrite = false;
  rejectReads = false;
  signedIn = false;
  invitations = [];
  members = [
    {
      id: "member_fixture",
      organizationId: org,
      userId: "user_fixture",
      role: "admin",
      createdAt: new Date("2026-01-01"),
      user: { id: "user_fixture", email: "fixture@example.test", name: "Fixture", image: null },
    },
  ];
});
after(async () => {
  release();
  for (const response of streams) response.end();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await GlobalRegistrator.unregister();
});

test("hosted app/account saves and deletes acknowledge shared rows before held reads; another organization stays independent", async () => {
  const registry = AtomRegistry.make();
  const queries = [
    organization.inventoryAtom(org),
    organization.inventoryAtom(otherOrg),
    hosted.appAtom(key),
    hostedAccounts.accountAtom(accountKey),
  ];
  const unmount = queries.map((query) => registry.mount<unknown>(query));
  try {
    await Promise.all(
      queries.map((query) =>
        read<Atom.Success<typeof query>, Atom.Failure<typeof query>>(registry, query),
      ),
    );
    holdReads = true;
    await mutate(registry, hostedAccounts.renameAccountAtom(accountKey), "Saved account");
    assert.equal(
      value(registry, hostedAccounts.accountAtom(accountKey)).account.label,
      "Saved account",
    );
    assert.equal(
      value(registry, organization.inventoryAtom(org)).accounts[0]?.label,
      "Saved account",
    );
    assert.equal(
      value(registry, organization.inventoryAtom(otherOrg)).accounts[0]?.label,
      "Original",
    );
    await mutate(registry, hosted.renameAppAtom(key), "Saved app");
    assert.equal(value(registry, hosted.appAtom(key)).name, "Saved app");
    assert.equal(
      value(registry, hostedAccounts.accountAtom(accountKey)).apps[0]?.name,
      "Saved app",
    );
    assert.equal(
      value(registry, organization.inventoryAtom(org)).accounts[0]?.label,
      "Saved account",
      "the second patch must not undo the first",
    );
    rejectWrite = true;
    await assert.rejects(mutate(registry, hosted.renameAppAtom(key), "Rejected"));
    assert.equal(value(registry, hosted.appAtom(key)).name, "Saved app");
    rejectWrite = false;
    await mutate(registry, hosted.removeAppAtom(key), undefined);
    assert.equal(value(registry, organization.inventoryAtom(org)).apps.length, 0);
    await mutate(registry, hostedAccounts.disconnectAccountAtom(accountKey), undefined);
    assert.equal(value(registry, organization.inventoryAtom(org)).accounts.length, 0);
  } finally {
    unmount.forEach((stop) => stop());
    registry.dispose();
    release();
  }
});

test("profile selection is acknowledged and connection completion waits for confirmed profile metadata", async () => {
  const registry = AtomRegistry.make();
  const connection = { organization: org, connection: AccountConnectionId.make("con_fixture") };
  const queries = [
    hosted.appAtom(key),
    profiles.profilesAtom(key),
    organization.inventoryAtom(org),
    hosted.toolsAtom(key),
    hosted.connectionAtom(connection),
  ];
  const stops = queries.map((query) => registry.mount<unknown>(query));
  try {
    await Promise.all(
      queries.map((query) =>
        read<Atom.Success<typeof query>, Atom.Failure<typeof query>>(registry, query),
      ),
    );
    holdReads = true;
    await mutate(registry, profiles.profileMutations({ ...key, profile: firstProfile.id }).update, {
      expectedRevision: firstProfile.revision,
      accounts: {},
    });
    assert.deepEqual(value(registry, profiles.profilesAtom(key))[0]?.accounts, {});
    assert.deepEqual(value(registry, organization.inventoryAtom(org)).profiles[0]?.accounts, {});
    const catalog = hosted.toolsAtom({
      ...key,
      profile: firstProfile.id,
      expectedProfileRevision: firstProfile.revision + 1,
    });
    stops.push(registry.mount(catalog));
    assert.ok(AsyncResult.isInitial(registry.get(catalog)));
    await mutate(registry, hosted.activateAppAtom(key), {
      deployment: DeploymentId.make("dpl_two"),
      expectedDeployment: firstApp.activeDeployment,
    });
    assert.equal(value(registry, hosted.appAtom(key)).activeDeployment, "dpl_two");
    await mutate(registry, hosted.submitConnectionAtom(connection), {
      label: "Default",
      method: "key",
      fields: Redacted.make({ token: "synthetic" }),
    });
    assert.ok(
      AsyncResult.isInitial(registry.get(hosted.appAtom(key))),
      "the account response does not contain the saved selection map",
    );
    assert.ok(AsyncResult.isInitial(registry.get(hosted.toolsAtom(key))));
    assert.ok(AsyncResult.isInitial(registry.get(organization.inventoryAtom(org))));
    assert.ok(AsyncResult.isInitial(registry.get(profiles.profilesAtom(key))));
    release();
    await read(registry, profiles.profilesAtom(key));
    assert.deepEqual(value(registry, profiles.profilesAtom(key))[0]?.accounts, {
      service: accountId,
    });
  } finally {
    stops.forEach((stop) => stop());
    registry.dispose();
    release();
  }
});

test(
  "local renames and deletion complete before delayed SSE snapshots without reverting shared metadata",
  { timeout: 5000 },
  async () => {
    const registry = AtomRegistry.make();
    const queries = [
      local.overviewAtom,
      local.appAtom(appId),
      localAccounts.accountAtom(accountId),
    ];
    const stops = queries.map((query) => registry.mount<unknown>(query));
    try {
      await Promise.all(
        queries.map((query) =>
          read<Atom.Success<typeof query>, Atom.Failure<typeof query>>(registry, query),
        ),
      );
      holdReads = true;
      await mutate(registry, localAccounts.renameAccountAtom(accountId), "Local saved");
      assert.equal(
        value(registry, localAccounts.accountAtom(accountId)).account.label,
        "Local saved",
      );
      assert.equal(value(registry, local.overviewAtom).accounts[0]?.label, "Local saved");
      await mutate(registry, localApps.renameAppAtom(appId), "Local app");
      assert.equal(value(registry, local.appAtom(appId)).app.name, "Local app");
      assert.equal(value(registry, local.overviewAtom).apps[0]?.name, "Local app");
      assert.equal(value(registry, local.overviewAtom).accounts[0]?.label, "Local saved");
      await mutate(registry, localOnboarding.deleteAppAtom(appId), undefined);
      assert.equal(value(registry, local.overviewAtom).apps.length, 0);
      await mutate(registry, localAccounts.disconnectAccountAtom(accountId), undefined);
      assert.equal(value(registry, local.overviewAtom).accounts.length, 0);
      release();
      await read(registry, local.overviewAtom);
      assert.deepEqual(value(registry, local.overviewAtom), {
        apps: [],
        profiles: [],
        accounts: [],
      });
    } finally {
      stops.forEach((stop) => stop());
      registry.dispose();
      release();
    }
  },
);

test("member changes acknowledge rows and invites while access waits for an authoritative read", async () => {
  const registry = AtomRegistry.make();
  const stops = [
    registry.mount(organization.membersAtom(org)),
    registry.mount(organization.accessAtom(org)),
  ];
  try {
    await read(registry, organization.membersAtom(org));
    await read(registry, organization.accessAtom(org));
    holdReads = true;
    await mutate(registry, organization.inviteAtom(org), {
      email: "new@example.test",
      role: "member",
    });
    assert.equal(value(registry, organization.membersAtom(org)).invitations.length, 1);
    rejectWrite = true;
    await assert.rejects(mutate(registry, organization.revokeInvitationAtom(org), "inv_fixture"));
    assert.equal(
      value(registry, organization.membersAtom(org)).invitations[0]?.status,
      "pending",
      "a failed revocation keeps the pending invitation",
    );
    rejectWrite = false;
    await mutate(registry, organization.revokeInvitationAtom(org), "inv_fixture");
    assert.equal(
      value(registry, organization.membersAtom(org)).invitations.length,
      0,
      "the revoked row disappears before the held refresh finishes",
    );
    await mutate(registry, organization.updateMemberRoleAtom(org), {
      memberId: "member_fixture",
      role: "member",
    });
    assert.equal(value(registry, organization.membersAtom(org)).members[0]?.role, "member");
    assert.ok(
      AsyncResult.isInitial(registry.get(organization.accessAtom(org))),
      "old admin controls must not stay available",
    );
    await mutate(registry, organization.removeMemberAtom(org), "member_fixture");
    assert.equal(value(registry, organization.membersAtom(org)).members.length, 0);
  } finally {
    stops.forEach((stop) => stop());
    registry.dispose();
    release();
  }
});

test("direct password and email-code success leaves session pending until a confirmed read", async () => {
  for (const kind of ["password", "code"] as const) {
    signedIn = false;
    const registry = AtomRegistry.make(),
      stop = registry.mount(session.sessionAtom);
    try {
      assert.equal(await read(registry, session.sessionAtom), null);
      holdReads = true;
      if (kind === "password")
        await mutate(registry, selfHostAuth.selfHostSignInAtom, {
          kind: "login",
          email: "fixture@example.test",
          password: "synthetic",
        });
      else
        await mutate(registry, cloudAuth.verifyCodeAtom, {
          email: "fixture@example.test",
          otp: "123456",
        });
      assert.ok(AsyncResult.isInitial(registry.get(session.sessionAtom)));
      assert.equal(registry.get(session.sessionAtom).waiting, true);
      release();
      await read(registry, session.sessionAtom);
      assert.equal(value(registry, session.sessionAtom)?.user.id, "user_fixture");
    } finally {
      stop();
      registry.dispose();
      release();
    }
  }
});

test("failed reconciliation keeps confirmed metadata and later external reads replace it", async () => {
  const registry = AtomRegistry.make(),
    query = hostedAccounts.accountAtom(accountKey),
    stop = registry.mount(query);
  const stopMutation = registry.mount(hostedAccounts.renameAccountAtom(accountKey));
  try {
    await read(registry, query);
    holdReads = true;
    await mutate(registry, hostedAccounts.renameAccountAtom(accountKey), "Confirmed");
    rejectReads = true;
    release();
    await settle(() => AsyncResult.isFailure(registry.get(query)));
    assert.equal(value(registry, query).account.label, "Confirmed");
    assert.ok(
      AsyncResult.isSuccess(registry.get(hostedAccounts.renameAccountAtom(accountKey))),
      "a failed read cannot turn a committed write into a failed write",
    );
    rejectReads = false;
    account = { ...account, label: "Changed elsewhere" };
    registry.refresh(query);
    assert.equal((await read(registry, query)).account.label, "Changed elsewhere");
  } finally {
    stop();
    stopMutation();
    registry.dispose();
    rejectReads = false;
    release();
  }
});

test("one account editor cannot cancel another organization's pending save", async () => {
  const registry = AtomRegistry.make();
  const other = { organization: otherOrg, account: accountId };
  const first = hostedAccounts.accountAtom(accountKey),
    second = hostedAccounts.accountAtom(other);
  const stops = [registry.mount(first), registry.mount(second)];
  try {
    await Promise.all([read(registry, first), read(registry, second)]);
    holdReads = true;
    const slow = mutate(registry, hostedAccounts.renameAccountAtom(accountKey), "Slow account");
    await settle(() => heldWrites.length > 0);
    await mutate(registry, hostedAccounts.renameAccountAtom(other), "Second account");
    assert.equal(value(registry, second).account.label, "Second account");
    for (const send of heldWrites.splice(0)) send();
    await slow;
    assert.equal(value(registry, first).account.label, "Slow account");
    assert.equal(value(registry, second).account.label, "Second account");
  } finally {
    for (const send of heldWrites.splice(0)) send();
    stops.forEach((stop) => stop());
    registry.dispose();
    release();
  }
});
