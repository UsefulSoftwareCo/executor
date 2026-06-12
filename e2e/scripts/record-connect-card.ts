// One-off recorder for the connect-card SSR-origin before/after.
//
// Captures the install command exactly as it FIRST paints (server-rendered,
// JS disabled — the literal SSR HTML) and again after the client hydrates,
// against a running cloud stack. On the buggy build the first paint shows the
// `http://127.0.0.1:4000` default and then flips to the real host at
// hydration; on the fixed build both frames already show the real host.
//
// It mints a real signed-in session through the headless WorkOS-emulator login
// (the same flow targets/cloud.ts uses), then screenshots just the command
// block so the URL is legible.
//
// Usage: bun e2e/scripts/record-connect-card.ts <base-url> <out-prefix>
//   writes <out-prefix>-ssr.png (first paint) and <out-prefix>-hydrated.png
import { randomUUID } from "node:crypto";

import { chromium } from "playwright";

const [baseUrl, outPrefix] = process.argv.slice(2);
if (!baseUrl || !outPrefix) {
  console.error("usage: bun e2e/scripts/record-connect-card.ts <base-url> <out-prefix>");
  process.exit(1);
}

const cookiePair = (response: Response, name: string): string | undefined => {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0];
  }
  return undefined;
};

// The real product login, headless (login → hosted AuthKit → callback), then
// the real create-organization flow so the card renders an org-scoped URL.
const signInWithOrg = async (email: string): Promise<string> => {
  const login = await fetch(new URL("/api/auth/login", baseUrl), { redirect: "manual" });
  const stateCookie = cookiePair(login, "wos-login-state");
  const authorizeUrl = new URL(login.headers.get("location") ?? "");
  if (!stateCookie) throw new Error(`login did not redirect to AuthKit (${login.status})`);
  authorizeUrl.searchParams.set("login_hint", email);
  const consent = await fetch(authorizeUrl, { redirect: "manual" });
  const callbackUrl = consent.headers.get("location");
  if (consent.status !== 302 || !callbackUrl) {
    throw new Error(`AuthKit emulator did not redirect (${consent.status})`);
  }
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { cookie: stateCookie },
  });
  let session = cookiePair(callback, "wos-session");
  if (!session) throw new Error(`callback set no session (${callback.status})`);

  const label = email.split("@")[0]!;
  const created = await fetch(new URL("/api/auth/create-organization", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(baseUrl).origin,
      cookie: session,
    },
    body: JSON.stringify({ name: `Org ${label}` }),
  });
  if (!created.ok) throw new Error(`create-organization failed (${created.status})`);
  session = cookiePair(created, "wos-session") ?? session;
  return session; // "wos-session=<sealed>"
};

const email = `user-${randomUUID().slice(0, 8)}@e2e.test`;
const session = await signInWithOrg(email);
const [cookieName, cookieValue] = session.split(/=(.*)/s);

const browser = await chromium.launch();

const shoot = async (label: string, javaScriptEnabled: boolean, outPath: string): Promise<void> => {
  const context = await browser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 800 },
    baseURL: baseUrl,
    javaScriptEnabled,
  });
  await context.addCookies([{ name: cookieName!, value: cookieValue!, url: baseUrl }]);
  const page = await context.newPage();
  // Always wait for the stylesheet to land (networkidle) before shooting: it's
  // render-blocking, so a real first paint already has `color-scheme: light
  // dark` applied and shiki's light-dark() syntax colors resolve to the dark
  // palette. Screenshotting at `commit` (pre-stylesheet) would instead capture
  // the light palette — an artifact no user sees. JS stays disabled for the
  // SSR shot only to freeze the pre-hydration origin (no client correction),
  // not to skip CSS.
  await page.goto("/", { waitUntil: "networkidle" });
  // The install command is the thing that flashes; screenshot just its block.
  const command = page.locator('pre:has-text("add-mcp")').first();
  await command.waitFor({ state: "visible", timeout: 15_000 });
  const text = (await command.innerText()).replace(/\s+/g, " ").trim();
  console.log(`${label}: ${text}`);
  await command.screenshot({ path: outPath });
  await context.close();
};

await shoot("ssr (first paint)", false, `${outPrefix}-ssr.png`);
await shoot("hydrated", true, `${outPrefix}-hydrated.png`);

await browser.close();
console.log(`wrote ${outPrefix}-ssr.png and ${outPrefix}-hydrated.png`);
