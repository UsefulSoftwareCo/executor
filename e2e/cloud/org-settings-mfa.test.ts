import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { verifyAdmin, verifyAdminInBrowser, responseCookies } from "./support/admin-mfa";
import { activeOrg, forBrowser, joinOrg } from "./support/session";

const decodeKey = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, value: Schema.String }),
);
const decodeUsers = Schema.decodeUnknownSync(
  Schema.Struct({
    users: Schema.Array(Schema.Struct({ email: Schema.NullOr(Schema.String) })),
  }),
);

scenario(
  "Organization MFA · protects settings without blocking workspace or backend credentials",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const locked = yield* target.newIdentity();
    const other = yield* target.newIdentity();
    const org = yield* activeOrg(target, locked);
    const unlocked = yield* verifyAdmin(target.baseUrl, locked);
    yield* Effect.promise(async () => {
      const send = (
        headers: Readonly<Record<string, string>> | undefined,
        method: string,
        path: string,
        body?: unknown,
      ) =>
        fetch(new URL(path, target.baseUrl), {
          method,
          headers: {
            ...headers,
            origin: new URL(target.baseUrl).origin,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      for (const path of [
        "/api/admin/users",
        "/api/account/members",
        "/api/account/roles",
        "/api/policies",
        "/api/account/api-keys",
        "/api/account/org-api-keys",
      ]) {
        expect((await send(locked.headers, "GET", path)).status, path).toBe(200);
      }
      const settings = [
        { method: "PATCH", path: "/api/account/name", body: { name: "Verified workspace" } },
        {
          method: "POST",
          path: "/api/account/members/invite",
          body: { email: "invited@example.com", roleSlug: "member" },
        },
        { method: "DELETE", path: "/api/account/members/membership_missing" },
        {
          method: "PATCH",
          path: "/api/account/members/membership_missing/role",
          body: { roleSlug: "admin" },
        },
        { method: "GET", path: "/api/org/domains" },
        { method: "POST", path: "/api/org/domains/verify-link", body: {} },
        { method: "DELETE", path: "/api/org/domains/domain_missing" },
        {
          method: "POST",
          path: "/api/auth/delete-organization",
          body: { confirmName: "Never delete this fixture" },
        },
      ];
      for (const action of settings) {
        expect(
          (await send(locked.headers, action.method, action.path, action.body)).status,
          action.path,
        ).toBe(403);
      }
      expect(
        (await send(unlocked.headers, "PATCH", "/api/account/name", { name: "Verified workspace" }))
          .status,
      ).toBe(200);
      expect((await send(unlocked.headers, "GET", "/api/org/domains")).status).toBe(200);
      const proof = unlocked.headers?.cookie
        ?.split("; ")
        .find((pair) => pair.startsWith("__Host-executor-admin-mfa="));
      if (!proof) throw new Error("Verification returned no proof");
      expect(
        (
          await send(
            { ...other.headers, cookie: `${other.headers?.cookie}; ${proof}` },
            "PATCH",
            "/api/account/name",
            { name: "Cross-user attempt" },
          )
        ).status,
      ).toBe(403);

      // Key management is on its own screen and remains available without MFA.
      const minted = await send(locked.headers, "POST", "/api/account/org-api-keys", {
        name: "Backend reader",
      });
      expect(minted.status).toBe(200);
      const key = decodeKey(await minted.json());
      try {
        const lock = await send(unlocked.headers, "POST", "/api/auth/admin-mfa/lock", {});
        expect(lock.status).toBe(200);
        const relocked = {
          ...unlocked.headers,
          cookie: responseCookies(unlocked.headers?.cookie ?? "", lock),
        };
        expect(
          (await send(relocked, "PATCH", "/api/account/name", { name: "Relocked attempt" })).status,
        ).toBe(403);
        const email = locked.credentials?.email;
        if (!email) throw new Error("Test identity has no email");
        const bearer = { authorization: `Bearer ${key.value}` };
        for (const path of [
          "/api/admin/users",
          `/api/admin/users/with-connections?email=${encodeURIComponent(email)}`,
        ]) {
          const response = await send(bearer, "GET", path);
          expect(response.status, path).toBe(200);
          expect(decodeUsers(await response.json()).users.map((user) => user.email)).toContain(
            email,
          );
        }
        expect(
          (
            await send(
              { ...bearer, "x-executor-organization": org.id },
              "PATCH",
              "/api/account/name",
              { name: "Machine settings attempt" },
            )
          ).status,
        ).toBe(401);
      } finally {
        expect(
          (await send(locked.headers, "DELETE", `/api/account/org-api-keys/${key.id}`)).status,
        ).toBe(200);
      }
    });
  }),
);

scenario(
  "Organization MFA · browser unlock is confined to organization settings",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const admin = yield* target.newIdentity();
    const org = yield* activeOrg(target, admin);
    yield* browser.session(forBrowser(admin), async ({ page, step }) => {
      await step("Open integrations without verifying", async () => {
        await visit(page, `/${org.slug}/integrations/add/openapi`);
        await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
      });
      await step(
        "Organization settings asks for an authenticator before showing controls",
        async () => {
          await visit(page, `/${org.slug}/org`);
          await page.getByRole("heading", { name: "Unlock organization settings" }).waitFor();
          expect(await page.getByLabel("Organization name", { exact: true }).count()).toBe(0);
          expect(await page.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0);
        },
      );
      await step("Enroll and verify, then edit the organization name", async () => {
        await verifyAdminInBrowser(page);
        await page.getByLabel("Organization name", { exact: true }).fill("Verified organization");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Organization name updated", { exact: true }).waitFor();
      });
      await step("Return to organization settings without another challenge", async () => {
        await visit(page, `/${org.slug}/api-keys`);
        await page.getByRole("heading", { name: "Personal keys", exact: true }).waitFor();
        await visit(page, `/${org.slug}/org`);
        await page.getByLabel("Organization name", { exact: true }).waitFor();
        expect(
          await page.getByRole("heading", { name: "Unlock organization settings" }).count(),
        ).toBe(0);
      });
      await step("Lock settings and keep API key management available", async () => {
        await page.getByRole("button", { name: "Lock organization settings" }).click();
        await page.getByRole("heading", { name: "Unlock organization settings" }).waitFor();
        await visit(page, `/${org.slug}/api-keys`);
        await page.getByRole("button", { name: "New org key" }).waitFor();
      });
    });
  }),
);

scenario(
  "Organization MFA · verification does not elevate a member to admin",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);
    const verified = yield* verifyAdmin(target.baseUrl, member);
    yield* Effect.promise(async () => {
      const headers = {
        ...verified.headers,
        origin: new URL(target.baseUrl).origin,
        "content-type": "application/json",
      };
      const domains = await fetch(new URL("/api/org/domains", target.baseUrl), { headers });
      expect(domains.status).toBe(200);
      const rename = await fetch(new URL("/api/account/name", target.baseUrl), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Member cannot rename" }),
      });
      expect(rename.status).toBe(403);
    });
  }),
);
