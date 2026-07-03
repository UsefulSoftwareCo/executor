// Cloud-specific: now that the gate renders the REAL shell during SSR (no
// skeleton), the integrations landing page's connect card is part of the very
// first painted HTML — including its `npx add-mcp <url>` install command. That
// URL is built from the server connection's origin, and the SPA only learns
// `window.location.origin` after it mounts; the SSR default is the desktop/CLI
// fallback `http://127.0.0.1:4000`. If SSR rendered with that default, the
// command would paint `127.0.0.1:4000` and then flip to the real host at
// hydration — a visible flash of the wrong URL on the first thing the user is
// told to copy.
//
// The gate now threads the request origin to the render, so the command is
// SSR'd against the REAL host from the first byte. These scenarios pin that on
// the raw document (pre-JS), where a flash would be observable, against the
// real WorkOS emulator session.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

/** A document navigation request — what the SSR gate keys on. */
const documentRequest = (url: URL, cookie: string) =>
  Effect.promise(() =>
    fetch(url, { redirect: "manual", headers: { accept: "text/html", cookie } }),
  );

/**
 * The install command is rendered inside a <pre> (shiki's grammar isn't loaded
 * during SSR, so the code block falls back to plain text). Stripping tags
 * reassembles the literal command even if hydration would later tokenize it
 * into colored spans.
 */
const installEndpointFromHtml = (html: string): string | null => {
  const text = html.replace(/<[^>]+>/g, " ");
  return /add-mcp\s+(https?:\/\/\S+\/mcp)/.exec(text)?.[1] ?? null;
};

scenario(
  "Connect card · the install command SSRs against the real host, never the 127.0.0.1 default",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;
    const expectedOrigin = new URL(target.baseUrl).origin;

    const identity = yield* target.newIdentity();
    const response = yield* documentRequest(
      new URL("/", target.baseUrl),
      identity.headers!.cookie!,
    );
    expect(response.status, "the authenticated landing page is served").toBe(200);

    const html = yield* Effect.promise(() => response.text());
    // The card is part of the first paint (the whole point of deleting the
    // skeleton) — if it weren't SSR'd, there'd be no flash to fix and this
    // guard would be vacuous, so assert it's actually there.
    const endpoint = installEndpointFromHtml(html);
    expect(endpoint, "the connect card's install command is in the SSR'd HTML").not.toBeNull();

    // The fix: the command's origin is the host that served the document, not
    // the client-side fallback the SPA would otherwise paint before mounting.
    expect(new URL(endpoint!).origin, "the install URL uses the real serving origin").toBe(
      expectedOrigin,
    );
    expect(endpoint!, "…and not the desktop/CLI default that used to flash").not.toContain(
      "127.0.0.1:4000",
    );
    // It's still the org-scoped path the user actually needs. Since #974
    // ("Org-slug console URLs across cloud, self-host, and cloudflare hosts"),
    // the install card prints the org's URL SLUG (e.g. /org-user-xxx/mcp), not
    // the legacy WorkOS org_<id> form — mount.ts's classifyMcpPath still
    // accepts either shape, but the slug form is what ships, so accept both
    // rather than pinning on the retired id-only shape.
    expect(endpoint!, "the install URL stays org-scoped").toMatch(
      /\/(?:org_[^/]+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/mcp$/,
    );
  }),
);
