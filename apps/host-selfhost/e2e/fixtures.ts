import { test as base, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// The "self-host app under test" handle.
//
// Scenarios talk to the app ONLY through this — never through internal modules —
// so a test reads like a user journey, not like plumbing. Today it wraps the
// running self-host server; this is also the seam where, later, a different host
// driver (cloud / cloudflare) gets swapped in while the scenarios above stay
// identical. API reads go through `page.request` so they share the browser's
// session cookie (i.e. they see exactly what the signed-in user sees).
// ---------------------------------------------------------------------------

export class SelfHostApp {
  constructor(readonly page: Page) {}

  async openConsole(): Promise<this> {
    await this.page.goto("/");
    return this;
  }

  /** `{ needsSetup }` — true on a brand-new instance, false once an org exists. */
  async setupStatus(): Promise<{ needsSetup: boolean }> {
    const res = await this.page.request.get("/api/setup-status");
    return res.json();
  }

  /** The signed-in user + their org, as the console itself sees it. */
  async account(): Promise<{
    user: { id: string; email: string; name: string; avatarUrl: string | null };
    organization: { id: string; name: string };
  }> {
    const res = await this.page.request.get("/api/account/me");
    expect(res.ok(), "GET /api/account/me should succeed for a signed-in admin").toBeTruthy();
    return res.json();
  }

  /**
   * The turnkey first-run: fill the setup form. The first person to sign up on a
   * fresh instance becomes the org owner (no invite code needed).
   */
  async completeFirstRunSetup(admin: {
    name: string;
    email: string;
    password: string;
  }): Promise<void> {
    await expect(this.page.locator("#name"), "the setup form should be showing").toBeVisible();
    await this.page.locator("#name").fill(admin.name);
    await this.page.locator("#email").fill(admin.email);
    await this.page.locator("#password").fill(admin.password);
    await this.page.getByRole("button", { name: /create admin account/i }).click();
  }
}

export const test = base.extend<{ app: SelfHostApp }>({
  app: async ({ page }, use) => {
    await use(new SelfHostApp(page));
  },
});

export { expect };
