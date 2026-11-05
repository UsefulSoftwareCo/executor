// Cloud-only: v1 creates no organizations — every new one is created in
// Executor v2 — and the one way an account without an organization still
// joins one here, a pending invitation into an existing organization, works as
// it always has.
//
//   1. `POST /api/auth/create-organization` answers `OrganizationCreationMoved`
//      with v2's sign-up page, for an account with no organization and for a
//      member alike, and nothing is created: no WorkOS organization or
//      membership, no change to the account's organizations, no new session.
//   2. An invited account with no organization is sent to /join instead of
//      v2, accepts there, and lands in the organization it was invited to.
import { connectEmulator } from "@executor-js/emulate";
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import type { Identity, Target as TargetShape } from "../src/target";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";
import { verifyAdmin } from "./support/admin-mfa";
import { activeOrg, cookieOf, organizationsOf, postJson } from "./support/session";

const WORKOS_URL = `http://127.0.0.1:${WORKOS_EMULATOR_PORT}`;

/** The account's WorkOS id: the user `/api/auth/me` reports. */
const userIdOf = (target: TargetShape, identity: Identity): Effect.Effect<string> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    return ((await response.json()) as { user: { id: string } }).user.id;
  });

/** The organizations WorkOS itself lists the user in — the system of record. */
const workosMembershipsOf = (userId: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(async () => {
    const response = await fetch(
      `${WORKOS_URL}/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}`,
      { headers: { authorization: "Bearer sk_test_emulate" } },
    );
    if (!response.ok) throw new Error(`WorkOS list memberships failed (${response.status})`);
    const body = (await response.json()) as { data: ReadonlyArray<{ organization_id: string }> };
    return body.data.map((membership) => membership.organization_id).sort();
  });

/** WorkOS create-organization / create-membership requests since `since`. */
const workosCreationsSince = (since: number): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(async () => {
    const workos = await connectEmulator({ baseUrl: WORKOS_URL });
    const entries = await workos.ledger.list(1000);
    return entries
      .filter(
        (entry) =>
          Date.parse(entry.timestamp) >= since &&
          entry.method === "POST" &&
          (entry.path === "/organizations" ||
            entry.path === "/user_management/organization_memberships"),
      )
      .map((entry) => entry.summary);
  });

/** The v2 sign-up page the auth gate sends a session with no organization to. */
const v2SignUpUrlOf = (target: TargetShape, identity: Identity): Effect.Effect<string> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/create-org", target.baseUrl), {
      redirect: "manual",
      headers: { accept: "text/html", cookie: cookieOf(identity) },
    });
    if (response.status !== 302) throw new Error(`/create-org answered ${response.status}`);
    return response.headers.get("location") ?? "";
  });

const createOrganization = (target: TargetShape, identity: Identity) =>
  Effect.promise(() =>
    fetch(new URL("/api/auth/create-organization", target.baseUrl), {
      method: "POST",
      headers: {
        ...(identity.headers ?? {}),
        "content-type": "application/json",
        origin: new URL(target.baseUrl).origin,
      },
      body: JSON.stringify({ name: "Should Not Exist" }),
    }),
  );

scenario(
  "Org creation · create-organization creates nothing and answers with Executor v2",
  { timeout: 120_000 },
  Effect.gen(function* () {
    yield* Api;
    const target = yield* Target;

    const orgless = yield* target.newIdentity({ org: false });
    const member = yield* target.newIdentity();
    const v2SignUp = yield* v2SignUpUrlOf(target, orgless);
    expect(new URL(v2SignUp).origin, "v2's sign-up page is on v2's host").not.toBe(
      new URL(target.baseUrl).origin,
    );

    for (const [who, identity] of [
      ["an account with no organization", orgless],
      ["a member of an organization", member],
    ] as const) {
      const userId = yield* userIdOf(target, identity);
      const workosBefore = yield* workosMembershipsOf(userId);
      const orgsBefore = yield* organizationsOf(target, identity);
      const since = Date.now();

      const response = yield* createOrganization(target, identity);
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly _tag?: string;
        readonly message?: string;
        readonly url?: string | null;
      };
      expect(response.status, `${who} is refused: creation has moved`).toBe(410);
      expect(body, `${who} is told where organizations are created now`).toEqual({
        _tag: "OrganizationCreationMoved",
        message: "Executor has moved. New organizations are created in Executor v2.",
        url: v2SignUp,
      });
      expect(
        response.headers.getSetCookie().filter((cookie) => cookie.startsWith("wos-session=")),
        `${who}'s session is left alone`,
      ).toEqual([]);

      expect(
        yield* workosMembershipsOf(userId),
        `WorkOS lists ${who} in the same organizations`,
      ).toEqual(workosBefore);
      expect(
        (yield* organizationsOf(target, identity)).organizations,
        `${who} has the same organizations in v1`,
      ).toEqual(orgsBefore.organizations);
      expect(
        yield* workosCreationsSince(since),
        "WorkOS was asked to create no organization or membership",
      ).toEqual([]);
    }
  }),
);

scenario(
  "Org creation · an invited account with no organization accepts on /join and lands in the org",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Api;
    const target = yield* Target;
    const browser = yield* Browser;

    const admin = yield* target.newIdentity();
    const org = yield* activeOrg(target, admin);
    const invitee = yield* target.newIdentity({ org: false });

    // The real invite flow into the admin's existing organization.
    const verifiedAdmin = yield* verifyAdmin(target.baseUrl, admin);
    yield* postJson(target, "/api/account/members/invite", verifiedAdmin, {
      email: invitee.credentials?.email,
    });

    // With a pending invitation, the gate sends the account to /join, not v2.
    const gated = yield* Effect.promise(() =>
      fetch(new URL("/", target.baseUrl), {
        redirect: "manual",
        headers: { accept: "text/html", cookie: cookieOf(invitee) },
      }),
    );
    expect(gated.status, "the app is not served without an organization").toBe(302);
    expect(gated.headers.get("location"), "…the invitation is accepted on /join").toBe("/join");

    yield* browser.session(invitee, async ({ page, step }) => {
      await step("Open the app: the pending invitation is shown", async () => {
        await visit(page, "/");
        await page.waitForURL((url) => url.pathname === "/join", { timeout: 30_000 });
        await page.getByRole("heading", { name: "You've been invited" }).waitFor();
        await page.getByRole("region", { name: "Invitation" }).getByText(org.name).waitFor();
      });

      await step("Accept the invitation and land in the organization", async () => {
        await page.getByRole("button", { name: "Accept invitation" }).click();
        await page.waitForURL(
          (url) => url.pathname === `/${org.slug}` || url.pathname === `/${org.slug}/`,
          { timeout: 30_000 },
        );
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
      });
    });

    const { organizations } = yield* organizationsOf(target, invitee);
    expect(
      organizations.map((organization) => organization.slug),
      "the invitee is now a member of exactly the organization they were invited to",
    ).toEqual([org.slug]);
  }),
);
