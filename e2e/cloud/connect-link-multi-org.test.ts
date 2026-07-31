// Cloud-only: the connect deep link's REASON FOR CARRYING AN ORG SLUG.
//
// An operator on the admin Users page copies a connect link for a member who
// hasn't connected something yet and sends it to them. `connectLinkUrl` builds
// that link org-PREFIXED (`/<org>/connect/<slug>`) rather than bare, and the
// failure that choice prevents is specific and silent: a recipient who belongs
// to several workspaces has ONE session-default org, and a bare `/connect/x`
// resolves against THAT one. They would land in the wrong workspace, connect a
// real credential there, and nothing anywhere would report a problem — the
// connection succeeds, it is just in the wrong tenant. The sender then keeps
// seeing an unconnected user.
//
// The existing coverage cannot catch this. `scenarios/connect-deep-link.test.ts`
// deliberately accepts EITHER URL form (it runs on hosts with and without an
// org segment) and its user belongs to one org, so both forms resolve to the
// same place. `packages/react/src/routes/connect-deep-link.test.ts` only proves
// the router parses the param. Neither has a second org to land in by mistake.
//
// So: a recipient who is a member of TWO orgs, whose session defaults to org B,
// follows an org-A-scoped link, and the credential must end up in org A.
//
// Both orgs register an integration under the SAME slug — that is what makes
// this a real test. With distinct slugs, org B's catalog would simply not
// contain the link's slug and the page would show its not-found state, so the
// scenario would pass for the wrong reason (a lookup miss rather than correct
// scoping). Sharing the slug means BOTH orgs can satisfy the link, and only the
// org prefix decides which one does.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { activeOrg, forBrowser, joinOrg, organizationsOf } from "./support/session";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

/** The spec's title, which the console uses to name a saved connection
 *  ("Personal Ping API"). */
const INTEGRATION_TITLE = "Ping API";

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: INTEGRATION_TITLE, version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

/** Register an apiKey-authenticated integration under an EXACT slug, so both
 *  orgs can hold the same catalog identity. */
const registerIntegration = (client: Client, slug: IntegrationSlug) =>
  client.openapi.addSpec({
    payload: {
      spec: { kind: "blob", value: pingSpec },
      slug,
      baseUrl: "http://127.0.0.1:59999", // never contacted during registration
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    },
  });

scenario(
  "Connect · an org-scoped connect link lands a multi-org recipient in the SENDING org",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    // Two workspaces with two different owners, and one person invited into
    // both. Built through the real invite flow, so the memberships are the ones
    // WorkOS actually issues.
    const ownerA = yield* target.newIdentity();
    const ownerB = yield* target.newIdentity();
    const recipientSeed = yield* target.newIdentity({ org: false });

    const joinedA = yield* joinOrg(target, ownerA, recipientSeed);
    // Accepting B's invitation SECOND re-seals the session onto org B, which is
    // exactly the hazard: the recipient's default is now the wrong workspace
    // for the link they are about to follow.
    const inOrgB = yield* joinOrg(target, ownerB, joinedA);

    // `joinedA`'s cookie was re-sealed by the SECOND accept, so it is stale and
    // must not be used to read anything — the recipient's live session is
    // `inOrgB`, pointed at whichever org a given read is about.
    const orgA = yield* activeOrg(target, ownerA);
    const orgB = yield* activeOrg(target, inOrgB);
    expect(orgA.id, "the two workspaces are genuinely different").not.toBe(orgB.id);

    const memberships = yield* organizationsOf(target, inOrgB);
    expect(
      memberships.organizations.map((org) => org.id).sort(),
      "the recipient really is a member of BOTH workspaces",
    ).toEqual([orgA.id, orgB.id].sort());
    expect(
      memberships.activeOrganizationId,
      "and their session defaults to org B — the org the link does NOT point at",
    ).toBe(orgB.id);

    const ownerAClient = yield* apiClient(api, ownerA);
    const ownerBClient = yield* apiClient(api, ownerB);

    // ONE slug, registered in BOTH catalogs (see the header note).
    const slug = IntegrationSlug.make(`multiorg-${randomBytes(4).toString("hex")}`);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* registerIntegration(ownerAClient, slug);
        yield* registerIntegration(ownerBClient, slug);

        // The link an operator copies off org A's Users page. Built here the
        // same way the page builds it (origin + org prefix + slug); the page's
        // own rendering of it is asserted in `admin-users-console.test.ts`.
        const origin = new URL(target.baseUrl).origin;
        const connectLink = `${origin}/${orgA.slug}/connect/${slug}`;

        // The recipient follows the link with their org-B-default session.
        yield* browser.session(forBrowser(inOrgB), async ({ page, step }) => {
          await step("Follow the org-A connect link with an org-B session", async () => {
            // `domcontentloaded`, not `networkidle`: the console holds live
            // connections open, so idle is not a state this page reaches. The
            // real wait is the redirect assertion below.
            await page.goto(connectLink, { waitUntil: "domcontentloaded" });
            // The deep link forwards into the integration detail route with the
            // add-account handoff — and it must keep ORG A's prefix through the
            // redirect. Landing on `/${orgB.slug}/...` here IS the bug.
            await page.waitForURL((url) => url.pathname === `/${orgA.slug}/integrations/${slug}`, {
              timeout: 30_000,
            });
            expect(
              new URL(page.url()).pathname.split("/").filter(Boolean)[0],
              "the connect flow stayed in the SENDING org, not the session default",
            ).toBe(orgA.slug);
            expect(new URL(page.url()).searchParams.get("addAccount")).toBe("1");
          });

          await step("Complete the connection from that page", async () => {
            const dialog = page.getByRole("dialog");
            await dialog.getByRole("heading", { name: /Add connection/ }).waitFor({
              timeout: 30_000,
            });
            // The credential field is labelled by the method's PLACEMENT (the
            // `authorization` header this spec declares), not by the variable.
            // Waited for explicitly: the field renders only once the modal has
            // loaded the integration's auth methods, which is a second fetch
            // after the heading appears.
            const credential = dialog.getByRole("textbox", { name: "authorization" });
            await credential.waitFor({ state: "visible", timeout: 90_000 });
            await credential.fill("recipient-personal-token");
            // The offered health check is opt-in (it runs only on "Check"), and
            // this spec's base URL is never served — so the credential is saved
            // unprobed, which is what this scenario is about: WHERE it lands,
            // not whether it works.
            await dialog.getByRole("button", { name: "Continue" }).click();
            await dialog.getByRole("button", { name: "Add connection" }).click();
            // The saved credential appears as a row in the accounts list of the
            // page it was saved from — and that page is ORG A's (its URL was
            // pinned to `orgA.slug` in the step above). So this row IS the
            // "landed in the sending workspace" half of the guarantee, read
            // from the surface the recipient is actually looking at.
            //
            // Waited on rather than the success toast (which auto-dismisses
            // below the fold) or the dialog's disappearance (which races the
            // close animation).
            await page
              .getByText(`Personal ${INTEGRATION_TITLE}`, { exact: true })
              .first()
              .waitFor({ state: "visible", timeout: 90_000 });
            expect(
              new URL(page.url()).pathname.split("/").filter(Boolean)[0],
              "the credential was saved from a page scoped to the SENDING org",
            ).toBe(orgA.slug);
          });

          // ── The other half: it is NOT in the session's default org ─────────
          //
          // Same person, same session, same integration slug — the only thing
          // that differs is the org in the URL. Org B registered the SAME slug,
          // so this page exists and renders; it simply must hold no connection.
          // Had the link resolved against the session default, THIS is the page
          // the credential would be on.
          await step("Org B — the session's own default — has none", async () => {
            await page.goto(`${origin}/${orgB.slug}/integrations/${slug}?tab=accounts`, {
              waitUntil: "domcontentloaded",
            });
            // Wait for the accounts panel to finish loading before asserting an
            // absence, so "not rendered yet" cannot pass as "not there". The
            // empty state is the positive signal that the list resolved AND is
            // empty — checking only for the missing row would also pass while
            // the list was still loading.
            await page
              .getByRole("button", { name: "Add connection" })
              .first()
              .waitFor({ state: "visible", timeout: 90_000 });
            await page
              .getByText("No connections", { exact: false })
              .first()
              .waitFor({ state: "visible", timeout: 90_000 });
            expect(
              await page.getByText(`Personal ${INTEGRATION_TITLE}`, { exact: true }).count(),
              "nothing landed in the org the recipient's session happened to default to",
            ).toBe(0);
          });
        });
      }),
      // Removing each org's spec takes its connections with it, so the
      // UI-created credential (whose name the console chose) needs no lookup.
      Effect.all(
        [
          ownerAClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
          ownerBClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);
