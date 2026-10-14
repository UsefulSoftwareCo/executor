import { expect, layer } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { batchedReads, batchPath } from "../support/read-batches.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
/** A document navigation, as a browser sends it. */
const navigation = { accept: "text/html" };

layer(HostedLive, { excludeTestServices: true })("Server-rendered dashboard", (it) => {
  it.effect(scenarios.serverRenderedDashboard.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        // Repeated and encoded parameters stand in for a signed OAuth query that must survive.
        const destination = `/org/${actors.organization.slug}/apps?view=accounts&scope=a%20b&scope=c`;

        const signedOut = yield* browser.use("Request a protected page while signed out", (page) =>
          page.context().request.get(destination, { maxRedirects: 0, headers: navigation }),
        );
        expect(signedOut.status()).toBeGreaterThanOrEqual(300);
        expect(signedOut.status()).toBeLessThan(400);
        expect(signedOut.headers()["location"]).toBe(
          `/login?redirect=${encodeURIComponent(destination)}`,
        );

        yield* browser.login(yield* freshOwnerSession);
        const failures: string[] = [];
        const repeatedReads: string[] = [];
        yield* browser.use("Watch hydration and the page's own reads", (page) => {
          page.on("console", (message) => {
            if (message.type() === "error" && hydrationFailure.test(message.text()))
              failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          page.on("request", (request) => {
            const path = new URL(request.url()).pathname;
            // Server-rendered reads reach the browser with the page instead of being repeated.
            if (/^\/api\/organizations\/[^/]+\/(inventory|access|resources)$/.test(path))
              repeatedReads.push(path);
          });
          return Promise.resolve();
        });

        // An organization root opens its apps.
        const root = yield* browser.use("Request an organization root", (page) =>
          page.context().request.get(`/org/${actors.organization.slug}`, {
            maxRedirects: 0,
            headers: navigation,
          }),
        );
        expect(root.status()).toBe(307);
        expect(new URL(root.headers()["location"] ?? "", "http://dashboard.invalid").pathname).toBe(
          `/org/${actors.organization.slug}/apps`,
        );

        const response = yield* browser.use("Open the apps page", (page) => page.goto(destination));
        if (response === null) throw new Error("The dashboard did not return a document");
        expect(response.status()).toBe(200);
        const headers = response.headers();
        expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(headers["x-frame-options"]).toBe("DENY");
        expect(headers["x-content-type-options"]).toBe("nosniff");
        expect(headers["cache-control"]).toContain("no-store");
        expect(headers["vary"]).toContain("Cookie");
        const html = yield* browser.use("Read the document the server sent", () => response.text());
        /** The document the server renders for a navigation to `path`. */
        const document = (path: string) =>
          browser.use(`Request ${path}`, (page) =>
            page
              .context()
              .request.get(path, { headers: navigation })
              .then((response) => response.text()),
          );
        const rendered = yield* document(destination);
        expect(rendered).toMatch(/>Executor</);
        // The installed app's card is data the server read before sending the page.
        expect(html).toContain('aria-label="Organization:');
        expect(html).toMatch(/>Executor</);

        yield* browser.use("The page is interactive with the server's content", (page) =>
          page.getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Let every streamed region hydrate", (page) =>
          page.waitForTimeout(1500),
        );
        expect(failures).toEqual([]);
        expect(repeatedReads).toEqual([]);
        yield* browser.checkpoint("Server-rendered apps page after hydration");

        const inventory = yield* browser.use("Find the installed Executor app", (page) =>
          page
            .context()
            .request.get(`/api/organizations/${actors.organization.id}/inventory`)
            .then((value) => value.json()),
        );
        const installed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
          }),
        )(inventory);
        const executor = installed.apps.find((app) => app.name === "Executor");
        if (executor === undefined) throw new Error("The Executor app is not installed");
        const appPage = yield* document(`/org/${actors.organization.slug}/apps/${executor.id}`);
        expect(appPage).toMatch(/>Executor</);

        // `/` resumes the organization this browser last used at its current address, so the page
        // never replaces its own URL while its data is still arriving.
        const signedIn = yield* browser.use("Read the signed-in identity", (page) =>
          page
            .context()
            .request.get("/api/auth/get-session")
            .then((value) => value.json()),
        );
        const identity = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
        )(signedIn);
        yield* browser.use("Remember this organization by its ID", (page) => {
          const origin = new URL(page.url());
          return page.context().addCookies([
            {
              name: `executor-org${origin.port === "" ? "" : `-${origin.port}`}`,
              value: encodeURIComponent(
                JSON.stringify({ user: identity.user.id, organization: actors.organization.id }),
              ),
              url: origin.origin,
            },
          ]);
        });
        const resumed = yield* browser.use("Request the bare root", (page) =>
          page.context().request.get("/", { maxRedirects: 0, headers: navigation }),
        );
        expect(
          new URL(resumed.headers()["location"] ?? "", "http://dashboard.invalid").pathname,
        ).toBe(`/org/${actors.organization.slug}/apps`);

        const consent = yield* browser.use("Open the MCP consent page", (page) =>
          page.context().request.get("/mcp/authorize?client_id=unknown&response_type=code", {
            headers: navigation,
          }),
        );
        expect(consent.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(consent.headers()["x-frame-options"]).toBe("DENY");

        // The page starts its reads with the access check, so a refusal arrives after them. A
        // refused document carries the refusal and none of the page's reads, whatever they
        // returned; the browser shows the refusal without reading the page's data itself.
        const refusedSlug = `withheld-${randomBytes(6).toString("hex")}`;
        const refusedPath = `/org/${refusedSlug}/apps`;
        const refused = yield* browser.use(
          "Request an organization this user cannot open",
          (page) =>
            page
              .context()
              .request.get(refusedPath, { headers: navigation })
              .then((response) => response.text()),
        );
        expect(refused).toContain("Organization unavailable");
        expect(refused).toContain(`hosted:organization-access:${refusedSlug}`);
        expect(refused).not.toMatch(/AtomHttpApi:(groups:list|resourceAccess:directory):/);
        const refusedReads: string[] = [];
        yield* browser.use("Watch the refused page's reads", (page) => {
          page.on("request", (request) => {
            const path = new URL(request.url()).pathname;
            // Only the refused organization's reads; the browser sends reads that start together
            // as one batch.
            const reads =
              path === batchPath
                ? batchedReads(request.postData())
                    .filter((read) => read.params["organization"] === refusedSlug)
                    .map((read) => `${read.group}:${read.endpoint}`)
                : path.startsWith(`/api/organizations/${refusedSlug}/`)
                  ? [path]
                  : [];
            refusedReads.push(
              ...reads.filter((read) =>
                /^(groups:list|resourceAccess:directory|organization:inventory)$|\/(groups|resources|inventory)$/.test(
                  read,
                ),
              ),
            );
          });
          return Promise.resolve();
        });
        yield* browser.use("Open the refused organization", (page) => page.goto(refusedPath));
        yield* browser.use("The refusal is shown after hydration", (page) =>
          page.getByText("Organization unavailable").waitFor({ state: "visible" }),
        );
        yield* browser.use("Let the refused page hydrate", (page) => page.waitForTimeout(1500));
        expect(failures).toEqual([]);
        expect(refusedReads).toEqual([]);
        yield* browser.checkpoint("Refused organization after hydration");
      }),
    ),
  );
});
