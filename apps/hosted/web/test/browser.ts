import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerBrowser } from "./dom.ts";
import { createServer } from "node:http";
import { after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Option, Schema } from "effect";
import { CreateTeam } from "../../cloud/src/contracts/onboarding.ts";
import { UploadedOrganizationIcon } from "@executor-js/hosted-server/organization-icon";

// Node route tests exercise DOM behavior. Vite owns stylesheet loading in the
// actual browser build; accept side-effect CSS imports from shared components.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

/** Synthetic HTTP fixture; the separate PGlite integration verifies real auth and authority. */
export const requests: string[] = [];
/** Recorded synthetic callback URLs verify a separate relay survives browser navigation. */
export const completedOAuthCallbacks: string[] = [];
/** Cloud onboarding fixtures exercise the real auth client over HTTP. */
export const passkeyFixture = { enrolled: false, unavailable: false };
/** Sign-out failure leaves the current session and destination intact. */
export const signOutFixture = { fails: false, signedOut: false };
export const organizations: Array<{
  id: string;
  slug: string;
  name: string;
  logo?: string | null;
}> = [
  { id: "org_alpha", slug: "alpha", name: "Alpha" },
  { id: "org_beta", slug: "beta", name: "Beta" },
];
/** Exercise confirmation and held responses through the real cloud client. */
export const onboardingFixture = {
  uploadedIcon: null as Uint8Array | null,
  failPrepare: false,
  failCreate: false,
  invitation: null as string | null,
  name: "Example Company",
  holdListsAfterCreate: false,
};
const account = {
  id: "acc_test",
  owner: "organization:org_alpha",
  provider: "prv_test",
  method: "oauth",
  label: "Default",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const pendingOrganizationLists: Array<() => void> = [];
/** Hold reads after a rename to exercise the real client while its query is stale. */
export const organizationFixture = {
  pauseLists: false,
  rejectRename: false,
  get pendingLists() {
    return pendingOrganizationLists.length;
  },
  releaseLists() {
    this.pauseLists = false;
    for (const reply of pendingOrganizationLists.splice(0)) reply();
  },
};
let activeOrganizationId = "org_beta";
/** Simulate library activity in another tab without changing either router. */
export const changeLibraryPreference = (organization: string) => {
  activeOrganizationId = organization;
};
const server = createServer((request, response) => {
  const path = request.url ?? "/";
  requests.push(path);
  const send = (value: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (path === "/api/onboarding/prepare") {
    if (onboardingFixture.failPrepare) return send({ _tag: "OnboardingUnavailable" }, 503);
    if (organizations.length > 0)
      return send({
        status: "ready",
        organizations: organizations.map((item) => ({ ...item, logo: item.logo ?? null })),
      });
    if (onboardingFixture.invitation !== null)
      return send({ status: "invitation", invitation: onboardingFixture.invitation });
    return send({
      status: "draft",
      suggestion: { name: onboardingFixture.name, logo: "https://example.test/icon.png" },
    });
  }
  if (path === "/api/onboarding/create") {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (onboardingFixture.failCreate) return send({ _tag: "OnboardingUnavailable" }, 503);
      if (onboardingFixture.invitation !== null)
        return send({ status: "invitation", invitation: onboardingFixture.invitation });
      const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(CreateTeam))(body);
      let logo: string | null;
      if (Schema.is(UploadedOrganizationIcon)(parsed.logo)) {
        onboardingFixture.uploadedIcon = parsed.logo.bytes;
        logo = "https://example.test/uploaded-team-icon.png";
      } else logo = parsed.logo;
      if (organizations.length === 0)
        organizations.push({ id: "org_auto", slug: "confirmed-team", name: parsed.name, logo });
      if (onboardingFixture.holdListsAfterCreate) organizationFixture.pauseLists = true;
      return send({
        status: "ready",
        organizations: organizations.map((item) => ({ ...item, logo: item.logo ?? null })),
      });
    });
    return;
  }
  if (path === "/api/auth/passkey/list-user-passkeys")
    return passkeyFixture.unavailable
      ? send({ code: "UNAVAILABLE" }, 503)
      : send(
          passkeyFixture.enrolled
            ? [
                {
                  id: "passkey_test",
                  name: "Existing passkey",
                  userId: "user_test",
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ]
            : [],
        );
  if (path.startsWith("/api/auth/passkey/generate-register-options"))
    return send({
      challenge: "Y2hhbGxlbmdl",
      rp: { id: "127.0.0.1", name: "Executor" },
      user: { id: "dXNlcl90ZXN0", name: "example@example.test", displayName: "Example" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });
  if (path === "/api/auth/organization/update") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (organizationFixture.rejectRename) return send({ code: "FORBIDDEN" }, 403);
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            organizationId: Schema.String,
            data: Schema.Struct({
              name: Schema.optionalKey(Schema.String),
              slug: Schema.optionalKey(Schema.String),
              logo: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          }),
        ),
      )(body);
      if (Option.isNone(parsed)) return send({ code: "INVALID" }, 400);
      const organization = organizations.find(
        (organization) => organization.id === parsed.value.organizationId,
      );
      if (!organization) return send({ code: "NOT_FOUND" }, 404);
      const { name, slug, logo } = parsed.value.data;
      if (
        slug !== undefined &&
        organizations.some((other) => other.id !== organization.id && other.slug === slug)
      )
        return send({ code: "ORGANIZATION_SLUG_ALREADY_TAKEN" }, 400);
      if (name !== undefined) organization.name = name;
      if (slug !== undefined) organization.slug = slug;
      if (logo !== undefined) organization.logo = logo;
      send(organization);
    });
    return;
  }
  if (path.startsWith("/api/auth/organization/list-members?"))
    return send({ members: [], total: 0 });
  if (path.startsWith("/api/auth/organization/list-invitations?")) return send([]);
  if (path === "/api/auth/organization/create") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            name: Schema.String,
            slug: Schema.String,
            keepCurrentActiveOrganization: Schema.Literal(true),
          }),
        ),
      )(body);
      if (Option.isNone(parsed)) return send({ message: "Explicit creation required" }, 400);
      const organization = {
        id: `org_${parsed.value.slug}`,
        slug: parsed.value.slug,
        name: parsed.value.name,
      };
      organizations.push(organization);
      send(organization);
    });
    return;
  }
  if (path === "/api/auth/organization/accept-invitation") {
    const organization = { id: "org_gamma", slug: "gamma", name: "Gamma" };
    organizations.push(organization);
    activeOrganizationId = organization.id;
    return send({
      invitation: { id: "invitation_gamma" },
      member: { organizationId: organization.id },
    });
  }
  if (path === "/api/auth/sign-out") {
    if (signOutFixture.fails) return send({ code: "UNAVAILABLE" }, 503);
    signOutFixture.signedOut = true;
    return send({ success: true });
  }
  if (path === "/api/auth/get-session")
    return send(
      signOutFixture.signedOut
        ? null
        : {
            user: {
              id: "user_test",
              email: "example@example.test",
              name: "Example",
              image: null,
            },
            session: { id: "session_test", activeOrganizationId },
          },
    );
  if (path === "/api/auth/organization/list") {
    if (organizationFixture.pauseLists) {
      pendingOrganizationLists.push(() => send(organizations));
      return;
    }
    return send(organizations);
  }
  if (path === "/api/catalog") return send([]);
  const organization = organizations.find(
    (item) =>
      path.startsWith(`/api/organizations/${item.id}/`) ||
      path.startsWith(`/api/organizations/${item.slug}/`),
  );
  if (organization && path.endsWith("/access"))
    return send({
      organization: organization.id,
      owner: `organization:${organization.id}`,
      role: "owner",
    });
  if (!organization && path.startsWith("/api/organizations/") && path.endsWith("/access"))
    return send({ _tag: "OrganizationForbidden" }, 403);
  if (path === "/api/organizations/org_alpha/connections/con_reconnect/oauth/complete") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ callbackUrl: Schema.String })),
      )(body);
      if (Option.isNone(parsed)) return send({ code: "INVALID" }, 400);
      completedOAuthCallbacks.push(parsed.value.callbackUrl);
      send(account);
    });
    return;
  }
  if (
    path === "/api/organizations/org_alpha/accounts/acc_test" ||
    path === "/api/organizations/alpha/accounts/acc_test"
  )
    return send({
      account,
      provider: {
        id: "prv_test",
        definition: {
          name: "Synthetic",
          auth: {
            oauth: { type: "oauth2", discover: "https://synthetic.example.test", response: {} },
          },
        },
      },
      apps: [],
      canManage: true,
    });
  if (organization && path.endsWith("/inventory")) return send({ apps: [], accounts: [] });
  return send({ message: "Not found" }, 404);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const fetch = globalThis.fetch;
registerBrowser(`${origin}/`);
// Node transport with browser relative URL resolution; every request reaches the HTTP fixture.
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: (input: string | URL | Request, init?: RequestInit) =>
    fetch(typeof input === "string" ? new URL(input, origin) : input, init),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
after(async () => {
  await GlobalRegistrator.unregister();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});
