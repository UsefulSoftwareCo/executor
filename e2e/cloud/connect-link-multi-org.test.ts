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
// So: a recipient who is a plain member of TWO orgs, whose session defaults to
// org B, follows an org-A-scoped link. The request must open the forced-Personal
// connection flow in org A — never enter a connection flow in B.
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
  "Connect · an org-scoped connect link resolves a multi-org recipient in the SENDING org",
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
            // A plain member can add a Personal connection. The org-A prefix
            // still proves the link resolved against the SENDING workspace
            // rather than session org B.
            await page.waitForURL((url) => url.pathname === `/${orgA.slug}/integrations/${slug}`, {
              timeout: 30_000,
            });
            expect(
              new URL(page.url()).pathname.split("/").filter(Boolean)[0],
              "the Personal add flow is scoped to the SENDING org, not the session default",
            ).toBe(orgA.slug);
            expect(
              new URL(page.url()).searchParams.get("addAccount"),
              "the member enters the add-account route",
            ).toBe("1");
            const dialog = page.getByRole("dialog");
            await dialog
              .getByText(`Add connection · ${INTEGRATION_TITLE}`, { exact: false })
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await dialog.getByText("Workspace", { exact: true }).count(),
              "the member is forced to Personal scope",
            ).toBe(0);
          });

          // ── The other half: it is NOT in the session's default org ─────────
          //
          // Same person, same session, same integration slug — the only thing
          // that differs is the org in the URL. Org B registered the SAME slug,
          // so this page exists and has its own Personal add flow too.
          await step("Org B has a separate Personal add action", async () => {
            await page.goto(`${origin}/${orgB.slug}/integrations/${slug}?tab=accounts`, {
              waitUntil: "domcontentloaded",
            });
            const add = page.getByRole("button", { name: "Add connection" });
            await add.waitFor({ state: "visible", timeout: 90_000 });
            expect(
              new URL(page.url()).pathname.split("/").filter(Boolean)[0],
              "navigating explicitly to org B changes the active add-flow scope",
            ).toBe(orgB.slug);
          });
        });
      }),
      // Remove the same-slug fixtures from both organizations.
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
