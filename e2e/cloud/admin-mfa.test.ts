import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TOTP } from "otpauth";
import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { joinOrg, orgSelectorOf } from "./support/session";

const Setup = Schema.Struct({ kind: Schema.Literal("enroll"), secret: Schema.String });
const decodeSetup = Schema.decodeUnknownOption(Setup);
const proofName = "__Host-executor-admin-mfa";

scenario(
  "Admin MFA · enroll, cancel, retry, and verify before opening admin settings",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ adminMfa: false });
    const path = `/${orgSelectorOf(identity)}/org`;
    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open organization settings without a second factor", async () => {
        await page.goto(path);
        await page.getByRole("heading", { name: "Verify to use admin settings" }).waitFor();
        const denied = await page.request.get("/api/admin/users", { headers: identity.headers });
        expect(denied.status()).toBe(403);
        const keyDenied = await page.request.get("/api/account/org-api-keys", {
          headers: identity.headers,
        });
        expect(keyDenied.status()).toBe(403);
      });
      await step("Start setup and cancel it", async () => {
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByAltText("Authenticator setup QR code").waitFor();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
      });
      let secret = "";
      await step("Start setup again and enter an incorrect code", async () => {
        const pending = page.waitForResponse((response) =>
          response.url().endsWith("/api/auth/admin-mfa/start"),
        );
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        const setup = Option.getOrNull(decodeSetup(await (await pending).json()));
        expect(setup).not.toBeNull();
        if (!setup) throw new Error("MFA setup did not return a secret");
        secret = setup.secret;
        const oldCode = new TOTP({ secret }).generate({ timestamp: Date.now() - 600_000 });
        await page.getByLabel("Six-digit code").fill(oldCode);
        await page.getByRole("button", { name: "Verify", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "That code did not work" }).waitFor();
        expect((await page.context().cookies()).some((cookie) => cookie.name === proofName)).toBe(
          false,
        );
      });
      await step("Enter the current code and open admin settings", async () => {
        await page.getByLabel("Six-digit code").fill(new TOTP({ secret }).generate());
        await page.getByRole("button", { name: "Verify", exact: true }).click();
        await page.getByRole("button", { name: "Add domain", exact: true }).waitFor();
        expect(new URL(page.url()).pathname).toBe(path);
        const proof = (await page.context().cookies()).find((cookie) => cookie.name === proofName);
        expect(proof).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
        const headers = { "x-executor-organization": orgSelectorOf(identity) };
        expect((await page.request.get("/api/admin/users", { headers })).status()).toBe(200);
      });
    });
  }),
);

scenario(
  "Admin MFA · members keep their normal view and cannot enroll as an admin",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const admin = yield* target.newIdentity();
    const member = yield* joinOrg(target, admin, yield* target.newIdentity({ org: false }));
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/admin-mfa/start", target.baseUrl), {
        method: "POST",
        headers: {
          ...member.headers,
          origin: new URL(target.baseUrl).origin,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    yield* browser.session(member, async ({ page, step }) => {
      await step("Open organization settings as a member", async () => {
        await page.goto(`/${orgSelectorOf(member)}/org`);
        await page.getByRole("heading", { name: "Members", exact: true }).waitFor();
        expect(
          await page.getByRole("heading", { name: "Verify to use admin settings" }).count(),
        ).toBe(0);
      });
    });
  }),
);
