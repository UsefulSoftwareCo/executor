// Selfhost-only (browser): guards two pieces of user feedback about the
// API-keys experience on a self-hosted instance —
//
//   1. the copy-API-key buttons work even on a plain-HTTP (non-secure) origin,
//      and
//   2. the API keys page is reachable from the main sidebar.
//
// Selfhost is the right target for (1): a self-hosted console is typically
// served over plain HTTP on a LAN host/IP — a NON-secure origin, where the
// browser does not expose `navigator.clipboard`. There the copy buttons fall
// back to `document.execCommand("copy")` (see @executor-js/react `lib/clipboard`).
// The harness runs on http://localhost, which IS a secure context, so the copy
// test drops `navigator.clipboard` to reproduce the real deployment and records
// what the page copies through the fallback.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

declare global {
  interface Window {
    // The copy test stashes the text the page copied (via the execCommand
    // fallback) here, so it can be read back out of the browser context.
    __e2eCopied?: Array<string>;
  }
}

scenario(
  "API keys · the page is reachable from the main sidebar",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Land on the dashboard", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        // The shared shell's main nav lists the workspace sections.
        await page.locator("nav").getByRole("link", { name: "Integrations" }).first().waitFor();
      });

      await step("The main sidebar links straight to API keys", async () => {
        // Feedback: "the api keys link should be in the main sidebar." Today the
        // link lives only in the account dropdown at the bottom of the sidebar
        // (a closed popover that isn't even mounted), so there is no API-keys
        // link in the main <nav>. Scoping to <nav> is what makes this the repro:
        // it ignores the dropdown and asserts a first-class sidebar item. The
        // failure message lists the items the sidebar actually has today.
        const navLinks = await page.locator("nav").getByRole("link").allInnerTexts();
        expect(navLinks, "API keys should be a first-class item in the main sidebar nav").toContain(
          "API keys",
        );
      });
    });
  }),
);

scenario(
  "API keys · the copy button copies a new key on a plain-HTTP self-host",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(AccountHttpApi, identity);

    // Selfhost is single-tenant, so name the key uniquely and revoke it after.
    const keyName = `copy-repro-${randomBytes(3).toString("hex")}`;

    yield* browser
      .session(identity, async ({ page, step }) => {
        // Recreate the real self-host deployment: a plain-HTTP, non-secure
        // origin. There the browser does not expose `navigator.clipboard`, so
        // the page must fall back to `document.execCommand("copy")` (the
        // universal insecure-context copy path). We drop the Clipboard API
        // exactly as a non-secure origin does, and record what the page copies
        // through the fallback so we can assert the key actually reached the
        // clipboard. (The harness itself runs on http://localhost, which IS a
        // secure context — without this it would mask the bug entirely.)
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            get: () => undefined,
          });
          const copied: Array<string> = [];
          window.__e2eCopied = copied;
          const exec = document.execCommand?.bind(document);
          document.execCommand = (command, ...rest) => {
            if (String(command).toLowerCase() === "copy") {
              // execCommand("copy") copies the current selection — capture it.
              const selected = window.getSelection ? String(window.getSelection()) : "";
              const active = document.activeElement;
              const fromField =
                active && "value" in active && typeof active.value === "string" ? active.value : "";
              copied.push(selected || fromField);
            }
            return exec ? exec(command, ...rest) : false;
          };
        });

        await step("Open the API keys page", async () => {
          await page.goto("/api-keys", { waitUntil: "networkidle" });
          await page.getByRole("heading", { name: "API keys", exact: true }).waitFor();
        });

        await step("Create a new key", async () => {
          await page.getByRole("button", { name: "New key" }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel("Name").fill(keyName);
          await dialog.getByRole("button", { name: "Create key" }).click();
          // The one-time secret panel renders once the key exists.
          await dialog.getByText("It is only shown once").waitFor();
        });

        await step("Copy the key with the copy button", async () => {
          const dialog = page.getByRole("dialog");
          // The exact secret the copy button should place on the clipboard.
          const keyValue = await dialog.locator("input[readonly]").first().inputValue();
          expect(keyValue, "the one-time secret is shown to copy").not.toBe("");

          // The copy button must place the key on the clipboard even here, where
          // navigator.clipboard is unavailable — it falls back to
          // execCommand("copy"), which has to survive the dialog's focus trap.
          await dialog.getByRole("button", { name: "Copy" }).first().click();

          const copied = await page.evaluate(() => window.__e2eCopied ?? []);
          expect(copied, "clicking copy should put the key on the clipboard").toContain(keyValue);
        });
      })
      .pipe(
        // Revoke the key whether the copy assertion passed or failed, so the
        // shared single-tenant instance is left clean.
        Effect.ensuring(
          Effect.gen(function* () {
            const list = yield* client.account.listApiKeys();
            const mine = list.apiKeys.find((key) => key.name === keyName);
            if (mine) yield* client.account.revokeApiKey({ params: { apiKeyId: mine.id } });
          }).pipe(Effect.ignore),
        ),
      );
  }),
);

scenario(
  "API keys · a copy that can't reach the clipboard surfaces an error toast",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(AccountHttpApi, identity);

    const keyName = `copy-fail-${randomBytes(3).toString("hex")}`;

    yield* browser
      .session(identity, async ({ page, step }) => {
        // Simulate a context where the copy genuinely can't happen: no
        // navigator.clipboard (non-secure origin) AND execCommand("copy")
        // refuses (some browsers/extensions block it). The copy then truly
        // fails, and the button must say so rather than silently doing nothing.
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            get: () => undefined,
          });
          document.execCommand = (command) => String(command).toLowerCase() !== "copy";
        });

        await step("Create a new key", async () => {
          await page.goto("/api-keys", { waitUntil: "networkidle" });
          await page.getByRole("button", { name: "New key" }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel("Name").fill(keyName);
          await dialog.getByRole("button", { name: "Create key" }).click();
          await dialog.getByText("It is only shown once").waitFor();
        });

        await step("A failed copy tells the user instead of failing silently", async () => {
          await page.getByRole("dialog").getByRole("button", { name: "Copy" }).first().click();
          await page.getByText("Failed to copy to clipboard").waitFor();
        });
      })
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const list = yield* client.account.listApiKeys();
            const mine = list.apiKeys.find((key) => key.name === keyName);
            if (mine) yield* client.account.revokeApiKey({ params: { apiKeyId: mine.id } });
          }).pipe(Effect.ignore),
        ),
      );
  }),
);
