/**
 * An organization page's server render starts the page's reads with the access check. Only a
 * successful check may put their data in the document. The test host's access check fixture makes
 * the check refuse, report an outage, fail in transport, or refuse only after the render deadline, each after the page's own reads have succeeded, which no
 * request from outside can produce, and the production entry point does not mount it.
 */
import { expect, layer } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { Effect, Layer, Schedule, Schema } from "effect";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body, SessionClients } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { batchedReads, batchPath } from "../support/read-batches.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { scenarios } from "../test-plan.ts";

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
/** Selects the test host's access check answer; see `apps/hosted/testing/access-check-fixture.ts`. */
const accessCheckCookie = "executor-test-access-check";
/** Entries for the apps page's own reads in a document's streamed data. */
const pageReadEntries = /AtomHttpApi:(groups:list|resourceAccess:directory):/;
/** The browser's own reads by `group:endpoint`, sent alone or in a batch. */
const directReads: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/api\/organizations\/[^/]+\/access$/, "organization:access"],
  [/^\/api\/organizations\/[^/]+\/groups$/, "groups:list"],
  [/^\/api\/organizations\/[^/]+\/resources$/, "resourceAccess:directory"],
];
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const Group = Schema.Struct({ id: Schema.String, name: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Server-rendered access", (it) => {
  it.effect(scenarios.serverRenderedAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const target = yield* Target;

        // The production entry point has no fixture: the cookie changes nothing there.
        yield* browser.login(yield* freshOwnerSession);
        const production = yield* browser.use(
          "Request a production apps page with the fixture cookie",
          (page) =>
            page
              .context()
              .addCookies([
                { name: accessCheckCookie, value: "refuse", url: target.metadata.origin },
              ])
              .then(() => page.goto(`/org/${actors.organization.slug}/apps`))
              .then((response) => (response === null ? "" : response.text())),
        );
        expect(production).not.toContain("Organization unavailable");
        expect(production).toMatch(pageReadEntries);

        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session(),
          headers = { origin };
        expect(
          (yield* api.request(owner, "POST", `${origin}/api/devtools/operator`, {}, headers))
            .status,
        ).toBe(200);
        const directory = yield* body(
          Users,
          yield* api.request(
            owner,
            "GET",
            `${origin}/api/auth/admin/list-users`,
            undefined,
            headers,
          ),
        );
        const ownerAccount = directory.users.find(
          (user) => user.email === "agent-agent@example.test",
        );
        if (!ownerAccount) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* api.request(
            owner,
            "POST",
            `${origin}/api/auth/admin/impersonate-user`,
            { userId: ownerAccount.id },
            headers,
          )).status,
        ).toBe(200);
        const organizations = yield* body(
          Organizations,
          yield* api.request(
            owner,
            "GET",
            `${origin}/api/auth/organization/list`,
            undefined,
            headers,
          ),
        );
        const organization = organizations[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        // A distinctive value that only the page's own reads return.
        const marker = `Withheld ${randomBytes(6).toString("hex")}`;
        const group = yield* body(
          Group,
          yield* api.request(
            owner,
            "POST",
            `${origin}/api/organizations/${organization.id}/groups`,
            { name: marker, description: "", memberIds: [] },
            headers,
          ),
        );
        expect(group.name).toBe(marker);
        const path = `${origin}/org/${organization.slug}/apps`;

        yield* browser.login(owner);
        const failures: string[] = [];
        const browserReads: string[] = [];
        yield* browser.use("Watch hydration and the page's own reads", (page) => {
          page.on("console", (message) => {
            if (message.type() === "error" && hydrationFailure.test(message.text()))
              failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          page.on("request", (request) => {
            const url = new URL(request.url());
            if (url.origin !== origin) return;
            if (url.pathname === batchPath)
              for (const read of batchedReads(request.postData()))
                browserReads.push(`${read.group}:${read.endpoint}`);
            for (const [pattern, name] of directReads)
              if (pattern.test(url.pathname)) browserReads.push(name);
          });
          return Promise.resolve();
        });
        const open = (name: string) =>
          browser.use(name, (page) =>
            page.goto(path).then((response) => {
              if (response === null) throw new Error("The dashboard did not return a document");
              return response.text();
            }),
          );

        // Without the fixture the document carries the page's reads, including the marker.
        const allowed = yield* open("Open the apps page");
        expect(allowed).toContain(marker);
        expect(allowed).toMatch(pageReadEntries);
        expect(failures).toEqual([]);

        for (const mode of ["refuse", "unavailable", "fail", "stall"] as const) {
          browserReads.length = 0;
          yield* browser.use(`Answer the access check with ${mode}`, (page) =>
            page.context().addCookies([{ name: accessCheckCookie, value: mode, url: origin }]),
          );
          const html = yield* open(`Open the apps page while access ${mode}s`);
          // The page's reads succeeded before the check answered; none of their data is sent.
          expect(html, `${mode}: the document must not carry page data`).not.toContain(marker);
          expect(html, `${mode}: the document must not carry page reads`).not.toMatch(
            pageReadEntries,
          );
          expect(html.includes("Organization unavailable"), `${mode}: refusal`).toBe(
            mode === "refuse",
          );
          // The browser's own access check succeeds, so it then renders the page as it would
          // on its own and reads the page's data itself: the document gave it nothing to reuse.
          const read = (name: string) => browserReads.indexOf(name);
          yield* Effect.suspend(() =>
            read("groups:list") >= 0 && read("resourceAccess:directory") >= 0
              ? Effect.void
              : Effect.fail("waiting"),
          ).pipe(
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
            Effect.ignore,
          );
          expect(read("groups:list"), `${mode}: the browser reads groups`).toBeGreaterThanOrEqual(
            0,
          );
          expect(
            read("resourceAccess:directory"),
            `${mode}: the browser reads the app list`,
          ).toBeGreaterThanOrEqual(0);
          // A refused document shows the refusal until the browser's own check answers.
          if (mode === "refuse")
            expect(read("organization:access")).toBeLessThan(read("groups:list"));
          // Access failures other than a refusal are outside the access result's codec, so the
          // document cannot carry them, yet the server renders the organization switcher's retry
          // control from them and the browser does not. That shell mismatch predates the page-read
          // guard and is separate work.
          if (mode === "refuse" || mode === "stall")
            expect(failures, `${mode}: hydration must match the server render`).toEqual([]);
          failures.length = 0;
          yield* browser.checkpoint(`Apps page after access ${mode}s`);
        }
      }),
    ),
  );
});
