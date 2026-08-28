// Cloud-specific: the integrations landing page's connect card prints an
// `npx add-mcp <url>` install command — the first thing a new user is told to
// copy. That URL's origin must be the host actually serving the console, never
// the desktop/CLI fallback `http://127.0.0.1:4000` the server-connection
// module defaults to when no origin is known.
//
// Under SPA serving there is no per-request document render: the shell is a
// static asset and the card renders client-side, deriving its origin from
// `window.location.origin`. This scenario pins the rendered card (the DOM the
// user actually copies from) to the serving host, against the real WorkOS
// emulator session.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Connect card · the rendered install command uses the real host, never the 127.0.0.1 default",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const expectedOrigin = new URL(target.baseUrl).origin;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      let commandText = "";
      await step("Open the console and read the connect card's command", async () => {
        await page.goto("/", { waitUntil: "commit" });
        const command = page.getByText(/add-mcp\s+https?:\/\//).first();
        await command.waitFor({ timeout: 30_000 });
        commandText = (await command.textContent()) ?? "";
      });

      const endpoint = /add-mcp\s+(https?:\/\/\S+\/mcp)/.exec(commandText)?.[1] ?? null;
      expect(endpoint, "the connect card renders an install command").not.toBeNull();

      expect(new URL(endpoint!).origin, "the install URL uses the real serving origin").toBe(
        expectedOrigin,
      );
      expect(endpoint!, "…and not the desktop/CLI default").not.toContain("127.0.0.1:4000");
      // It's still the org-scoped path the user actually needs. Since #974
      // ("Org-slug console URLs across cloud, self-host, and cloudflare
      // hosts"), the install card prints the org's URL SLUG (e.g.
      // /org-user-xxx/mcp), not the legacy WorkOS org_<id> form —
      // mount.ts's classifyMcpPath still accepts either shape, but the slug
      // form is what ships, so accept both rather than pinning on the
      // retired id-only shape.
      expect(endpoint!, "the install URL stays org-scoped").toMatch(
        /\/(?:org_[^/]+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/mcp$/,
      );
    });
  }),
);
