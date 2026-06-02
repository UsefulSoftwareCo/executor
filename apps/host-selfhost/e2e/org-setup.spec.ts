import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Milestone scenario: an org gets set up.
//
// The whole assembled stack is exercised through real surfaces — the browser
// drives the zero-config first-run form, the real Better Auth signup runs, and
// we confirm the org + owner the way the console itself would (the same API the
// signed-in UI calls). No internals are touched; if any seam between frontend,
// auth, API, and DB is broken, this goes red.
// ---------------------------------------------------------------------------

// Narrated play-by-play for the watchable run (shows up in the terminal + the
// HTML report alongside each step).
const narrate = (message: string) => console.log(`   ▸ ${message}`);

test("an org gets set up — zero-config first run", async ({ app, page }) => {
  await test.step("a brand-new instance reports it needs setup", async () => {
    narrate("opening the console on a freshly-booted, unconfigured self-host");
    await app.openConsole();
    expect((await app.setupStatus()).needsSetup, "a fresh instance needs setup").toBe(true);
    await expect(page.locator("#name"), "the first-run setup form is shown").toBeVisible();
  });

  await test.step("the first person signs up and becomes the org owner", async () => {
    narrate("filling the first-run setup form as Ada");
    await app.completeFirstRunSetup({
      name: "Ada Admin",
      email: "ada@example.com",
      password: "hunter2hunter2",
    });
  });

  await test.step("the org is set up and the admin lands in the console", async () => {
    narrate("confirming we left setup and the org now exists with Ada as owner");
    // We left the setup form (the app reloaded into the authenticated console).
    await expect(page.locator("#name")).toBeHidden();
    expect((await app.setupStatus()).needsSetup, "setup is complete").toBe(false);

    const account = await app.account();
    expect(account.user.email).toBe("ada@example.com");
    expect(account.organization.name).toBe("E2E Test Org");
    narrate(`org "${account.organization.name}" is set up, owned by ${account.user.email}`);
  });
});
