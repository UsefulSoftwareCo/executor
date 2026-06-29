// Selfhost (browser, recorded): a connecting MCP client must pass a human
// approval screen before it is granted a token. The recording (video + trace +
// per-step screenshots) is the artifact.
//
// The self-host serving layer forces `prompt=consent` on every MCP authorize
// (src/auth/force-mcp-consent) and Better Auth is configured with a consent
// page (`oidcConfig.consentPage` → the SPA's /oauth/consent), so an
// authenticated authorize stops on the approval screen rather than auto-issuing
// a code. This scenario drives that: authorize → approval screen → Approve →
// back to the client with a code.
//
// (Driven from a signed-in browser rather than typing into the login page
// because the approval step — not the login UI — is the subject, and the login
// page does not cleanly resume the OAuth request after sign-in.)
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

interface AuthServerMetadata {
  readonly authorization_endpoint: string;
  readonly registration_endpoint: string;
}

// Registered at DCR; the approval screen looks this up to show "Connect …?".
const CLIENT_NAME = "Claude (MCP) — demo";

scenario(
  "MCP OAuth · a connecting client must pass the approval screen",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    // A signed-in identity (the browser context is seeded with its session
    // cookies) — the subject is what an MCP client's authorize request does for
    // an already-authenticated user.
    const identity = yield* target.newIdentity();

    // Authorization-server discovery + dynamic client registration (what a real
    // MCP client does before it ever opens a browser). The redirect lands back
    // in the app so the recording ends on the authenticated console.
    const metadata = (yield* Effect.promise(() =>
      fetch(new URL("/.well-known/oauth-authorization-server", target.baseUrl)).then((r) =>
        r.json(),
      ),
    )) as AuthServerMetadata;

    const redirectUri = new URL("/", target.baseUrl).toString();
    const registered = (yield* Effect.promise(() =>
      fetch(metadata.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }).then((r) => r.json()),
    )) as { readonly client_id: string };

    const verifier = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", registered.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", randomUUID());
    authorizeUrl.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorize = authorizeUrl.toString();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("A signed-in user is using their Executor instance", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        // Confirm we're in the app, not bounced to sign-in.
        expect(new URL(page.url()).pathname, "the session is active (not on /login)").not.toBe(
          "/login",
        );
      });

      await step(
        "An MCP client requests authorization — the approval screen gates it",
        async () => {
          // A connecting MCP client opens this authorize URL. The server forces
          // prompt=consent, so it stops here on the approval screen instead of
          // auto-issuing a code.
          await page.goto(authorize, { waitUntil: "networkidle" });
          await page.locator("#mcp-consent-allow").waitFor();
          expect(
            new URL(page.url()).pathname,
            "the authorize request lands on the approval screen, not a redirect",
          ).toBe("/mcp-consent");
          // The screen shows the registered client NAME (looked up server-side
          // and appended to the consent redirect), not just the opaque id.
          await page.getByText(`Connect ${CLIENT_NAME}?`).waitFor();
        },
      );

      await step("Allow — the client is granted a code and sent back", async () => {
        await page.locator("#mcp-consent-allow").click();
        await page.waitForURL((url) => url.searchParams.has("code"), { timeout: 20_000 });
        const landed = new URL(page.url());
        expect(landed.origin + landed.pathname, "approval redirects back to the client").toBe(
          redirectUri.replace(/\/$/, "") + "/",
        );
        expect(
          landed.searchParams.get("code"),
          "a code is granted only after explicit approval",
        ).toBeTruthy();
      });
    });
  }),
);
