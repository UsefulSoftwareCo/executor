import { Effect, Option, Schema } from "effect";
import { TOTP } from "otpauth";
import type { Page } from "playwright";
import type { Identity } from "../../src/target";

// Each synthetic identity owns a test authenticator, reused for subsequent challenges.
const testAuthenticators = new Map<string, string>();

const Setup = Schema.Struct({ kind: Schema.Literal("enroll"), secret: Schema.String });
const decodeSetup = Schema.decodeUnknownOption(Setup);
const Challenge = Schema.Struct({ kind: Schema.Literal("challenge") });
const decodeChallenge = Schema.decodeUnknownOption(Challenge);
const Verified = Schema.Struct({ verified: Schema.Literal(true) });
const decodeVerified = Schema.decodeUnknownOption(Verified);
const decodeVerifiedState = Schema.decodeUnknownOption(
  Schema.Struct({ state: Schema.Literal("verified") }),
);

/** Apply response cookie rotations and deletions to a test client's cookie header. */
export const responseCookies = (current: string, response: Response): string => {
  const cookies = new Map(browserCookies(current).map(({ name, value }) => [name, value]));
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0];
    if (!pair) throw new Error("Empty response cookie");
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("Invalid response cookie");
    const name = pair.slice(0, separator);
    if (/;\s*max-age=0(?:;|$)/i.test(header)) cookies.delete(name);
    else cookies.set(name, pair.slice(separator + 1));
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
};

/** Read all cookie pairs, including admin verification, into browser fixtures. */
export const browserCookies = (cookie: string): NonNullable<Identity["cookies"]> =>
  cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) throw new Error("Invalid test cookie");
      const name = pair.slice(0, separator);
      return {
        name,
        value: pair.slice(separator + 1),
        ...(name.startsWith("__Host-") ? { secure: true } : {}),
      };
    });

/** Verify a test admin through the product, retaining the test authenticator for later sign-ins. */
export const verifyAdmin = (baseUrl: string, identity: Identity): Effect.Effect<Identity> =>
  Effect.promise(async () => {
    const email = identity.credentials?.email;
    if (!email) throw new Error("Test identity has no email");
    const headers = {
      ...identity.headers,
      origin: new URL(baseUrl).origin,
      "content-type": "application/json",
    };
    const status = await fetch(new URL("/api/auth/admin-mfa", baseUrl), { headers });
    if (status.ok && Option.isSome(decodeVerifiedState(await status.json()))) return identity;
    const started = await fetch(new URL("/api/auth/admin-mfa/start", baseUrl), {
      method: "POST",
      headers,
      body: "{}",
    });
    if (!started.ok) throw new Error(`Admin enrollment failed (${started.status})`);
    const raw: unknown = await started.json();
    const setup = Option.getOrNull(decodeSetup(raw));
    const secret =
      setup?.secret ??
      (Option.isSome(decodeChallenge(raw)) ? testAuthenticators.get(email) : undefined);
    if (!secret) throw new Error("Missing test authenticator");
    testAuthenticators.set(email, secret);
    const pending = responseCookies(identity.headers?.cookie ?? "", started);
    const verified = await fetch(new URL("/api/auth/admin-mfa/verify", baseUrl), {
      method: "POST",
      headers: { ...headers, cookie: pending },
      body: JSON.stringify({ code: new TOTP({ secret }).generate() }),
    });
    if (!verified.ok || Option.isNone(decodeVerified(await verified.json())))
      throw new Error(`Admin verification failed (${verified.status})`);
    const proof = verified.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("__Host-executor-admin-mfa="))
      ?.split(";")[0];
    if (!proof) throw new Error("Admin verification set no proof cookie");
    const cookie = responseCookies(pending, verified);
    return {
      ...identity,
      headers: { ...identity.headers, cookie },
      cookies: browserCookies(cookie),
    };
  });

/** Complete the visible MFA prompt using enrollment or this test identity's authenticator. */
export const verifyAdminInBrowser = async (page: Page, secret?: string): Promise<void> => {
  await page.getByRole("heading", { name: "Unlock organization settings" }).waitFor();
  const [started] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/admin-mfa/start")),
    page.getByRole("button", { name: "Continue", exact: true }).click(),
  ]);
  const raw: unknown = await started.json();
  const setup = Option.getOrNull(decodeSetup(raw));
  const key = setup?.secret ?? (Option.isSome(decodeChallenge(raw)) ? secret : undefined);
  if (!started.ok() || !key) throw new Error("Could not open the test authenticator");
  await page.getByLabel("Six-digit code").fill(new TOTP({ secret: key }).generate());
  const [verified] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/admin-mfa/verify")),
    page.getByRole("button", { name: "Verify", exact: true }).click(),
  ]);
  if (!verified.ok()) throw new Error("Browser admin verification failed");
  await page
    .getByRole("heading", { name: "Unlock organization settings" })
    .waitFor({ state: "detached" });
  // Successful verification reloads the document, so Chromium can discard that
  // response body. Check the persisted session through the product instead.
  const selector = new URL(page.url()).pathname.split("/")[1];
  if (!selector) throw new Error("Admin verification has no organization scope");
  const status = await page.request.get("/api/auth/admin-mfa", {
    headers: { "x-executor-organization": selector },
  });
  if (!status.ok() || Option.isNone(decodeVerifiedState(await status.json())))
    throw new Error("The browser session is not verified");
};
