import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import type { BrowserContext } from "playwright";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { reveal, secret } from "../support/failure-text.ts";
import { managementApp } from "../support/management-app.ts";
import { consentTo } from "../support/mcp-connections.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const Minted = Schema.Struct({ url: Schema.String, expiresAt: Schema.String });
const SessionUser = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const Tokens = Schema.Struct({ access_token: Schema.NonEmptyString });
const linkPath = "/api/auth/desktop/session-link";
const loopback = "http://127.0.0.1:9/callback";

type Token = Redacted.Redacted<string>;

const desktopFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser,
    http = yield* HttpClient.HttpClient,
    target = yield* Target;
  const hosts = targetHosts(target);
  const origin = hosts.browser;
  const resourceOrigin = target.metadata.origin;
  const anonymous = yield* api.session();
  const cookieName = origin.startsWith("https:")
    ? "__Host-executor-desktop-link"
    : "executor-desktop-link";
  const bearer = (token: Token) => ({ authorization: `Bearer ${reveal(token)}` });
  const status = (token: Token, method: "GET" | "POST", url: string) =>
    http
      .execute(
        (method === "POST"
          ? HttpClientRequest.post(url).pipe(
              HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "ping" }),
            )
          : HttpClientRequest.get(url)
        ).pipe(HttpClientRequest.setHeaders(bearer(token))),
      )
      .pipe(Effect.map((response) => response.status));
  const binding = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, binding: createHash("sha256").update(verifier).digest("hex") };
  };
  const mint = (token: Token, request: Record<string, string>) =>
    api.request(anonymous, "POST", linkPath, request, bearer(token));
  const mintStatus = (token: Token, request: Record<string, string>) =>
    mint(token, request).pipe(Effect.map((response) => response.status));
  const minted = (token: Token, returnTo?: string) =>
    Effect.gen(function* () {
      const bound = binding();
      const response = yield* mint(token, {
        binding: bound.binding,
        ...(returnTo === undefined ? {} : { returnTo }),
      });
      expect(response.status).toBe(200);
      const link = yield* body(Minted, response);
      expect(new URL(link.url).origin).toBe(origin);
      return { url: secret(link.url), expiresAt: link.expiresAt, verifier: secret(bound.verifier) };
    });
  const userOf = (session: Session) =>
    api
      .request(session, "GET", "/api/auth/get-session")
      .pipe(Effect.flatMap((response) => body(SessionUser, response)));
  const bind = (context: BrowserContext, verifier: Token) =>
    context.addCookies([
      {
        name: cookieName,
        value: reveal(verifier),
        domain: new URL(origin).hostname,
        path: "/",
        httpOnly: true,
        secure: origin.startsWith("https:"),
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + 60,
      },
    ]);
  const fresh = <A>(
    name: string,
    run: (context: BrowserContext) => Promise<A>,
    options: { readonly cookies?: Session; readonly verifier?: Token } = {},
  ) =>
    Effect.gen(function* () {
      const added =
        options.cookies === undefined ? undefined : reveal(yield* options.cookies.cookies);
      return yield* browser.use(name, (page) => {
        const opened = page.context().browser()?.newContext();
        if (opened === undefined) return Promise.reject(new Error("No browser to open"));
        return opened.then((context) =>
          (added === undefined ? Promise.resolve() : context.addCookies([...added]))
            .then(() =>
              options.verifier === undefined ? undefined : bind(context, options.verifier),
            )
            .then(() => run(context))
            .finally(() => context.close()),
        );
      });
    });
  const redeemed = (
    context: BrowserContext,
    url: Token,
    headers: Record<string, string> = { "x-executor-desktop-link": "1" },
  ) =>
    context.request.get(reveal(url), { maxRedirects: 0, headers }).then((response) =>
      context.request
        .get(`${origin}/api/auth/get-session`)
        .then((session): Promise<unknown> => session.json())
        .then((session) =>
          context.cookies(origin).then((cookies) => ({
            status: response.status(),
            location: response.headers()["location"],
            cacheControl: response.headers()["cache-control"],
            session,
            bindingKept: cookies.some((cookie) => cookie.name === cookieName),
          })),
        ),
    );
  const refused = { status: 302, location: `${origin}/login`, session: null };
  const consentDesktop = (session: Session, redirects: readonly string[]) =>
    Effect.gen(function* () {
      const registered = yield* api.request(
        yield* api.session(),
        "POST",
        "/api/auth/oauth2/register",
        {
          client_name: "Executor desktop",
          redirect_uris: redirects,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      );
      if (registered.status !== 201)
        return { outcome: "registration refused", status: registered.status } as const;
      const { client_id: clientId } = yield* body(
        Schema.Struct({ client_id: Schema.String }),
        registered,
      );
      const verifier = randomBytes(32).toString("base64url");
      const resource = `${resourceOrigin}/api/desktop`;
      const redirect = redirects[0] ?? loopback;
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        scope: "desktop offline_access",
        resource,
        state: randomBytes(16).toString("hex"),
      });
      const opened = yield* api.request(
        session,
        "GET",
        `/api/auth/oauth2/authorize?${query.toString()}`,
        undefined,
        { accept: "application/json" },
      );
      expect(opened.status).toBe(200);
      const next = new URL(
        (yield* body(Schema.Struct({ url: Schema.String }), opened)).url,
        origin,
      );
      if (next.origin !== origin)
        return { outcome: "authorization refused", status: opened.status } as const;
      const consented = yield* api.request(
        session,
        "POST",
        "/api/auth/oauth2/consent",
        { accept: true, oauth_query: next.search.slice(1) },
        { "x-executor-organization": actors.organization.id },
      );
      if (consented.status !== 200)
        return { outcome: "consent refused", status: consented.status } as const;
      const { url } = yield* body(Schema.Struct({ url: Schema.String }), consented);
      const exchanged = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* http.execute(
            HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
              HttpClientRequest.bodyUrlParams({
                grant_type: "authorization_code",
                client_id: clientId,
                code: new URL(url).searchParams.get("code") ?? "",
                code_verifier: verifier,
                redirect_uri: redirect,
                resource,
              }),
            ),
          );
          expect(response.status).toBe(200);
          return yield* response.json;
        }),
      );
      const tokens = yield* Schema.decodeUnknownEffect(Tokens)(exchanged);
      return { outcome: "granted", token: secret(tokens.access_token) } as const;
    });
  const desktopToken = (session: Session) =>
    consentDesktop(session, [loopback]).pipe(
      Effect.flatMap((consent) =>
        consent.outcome === "granted"
          ? Effect.succeed(consent.token)
          : Effect.die(new Error(`Desktop consent was not granted: ${consent.outcome}`)),
      ),
    );
  return {
    api,
    actors,
    hosts,
    origin,
    resourceOrigin,
    anonymous,
    cookieName,
    bearer,
    status,
    binding,
    bind,
    mint,
    mintStatus,
    minted,
    userOf,
    fresh,
    redeemed,
    refused,
    consentDesktop,
    desktopToken,
  };
});

layer(HostedLive, { excludeTestServices: true })("Desktop sign-in", (it) => {
  it.effect(scenarios.desktopSignIn.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          hosts,
          origin,
          anonymous,
          cookieName,
          bearer,
          status,
          binding,
          mintStatus,
          minted,
          userOf,
          fresh,
          redeemed,
          refused,
        } = yield* desktopFixture;
        const oauth = yield* McpOAuth,
          evidence = yield* Evidence,
          browser = yield* Browser,
          http = yield* HttpClient.HttpClient;
        yield* browser.login(actors.owner);
        const authorized = yield* evidence.step(
          "Authorize the desktop through browser consent with PKCE and a loopback redirect",
          oauth.authorizeDesktop,
        );
        const grant = secret(reveal(authorized.tokens).access_token);
        const { app, account } = yield* managementApp(actors.owner);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const owner = (yield* userOf(actors.owner)).user.id;
        const admin = (yield* userOf(actors.admin)).user.id;

        const location = yield* api.request(
          anonymous,
          "GET",
          `${prefix}/apps/${app.id}/ui`,
          undefined,
          bearer(grant),
        );
        expect(location.status).toBe(200);
        expect(location.body).toEqual(
          (yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`)).body,
        );
        expect(
          Object.keys(yield* body(Schema.Record(Schema.String, Schema.Unknown), location)).filter(
            (field) => !["status", "url", "name", "icon", "menuBar", "reason"].includes(field),
          ),
        ).toEqual([]);
        const git = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/git`),
        );
        const elsewhere = `/api/organizations/org_${randomUUID().replaceAll("-", "")}`;
        expect(
          yield* Effect.all({
            app: status(grant, "GET", `${hosts.api}${prefix}/apps/${app.id}`),
            inventory: status(grant, "GET", `${hosts.api}${prefix}/inventory`),
            source: status(grant, "GET", `${hosts.api}${prefix}/apps/${app.id}/source`),
            account: status(grant, "GET", `${hosts.api}${prefix}/accounts/${account}`),
            groups: status(grant, "GET", `${hosts.api}${prefix}/groups`),
            mcp: status(grant, "POST", `${hosts.mcp}/mcp`),
            git: status(grant, "GET", `${git.url}/info/refs?service=git-upload-pack`),
            otherOrganization: status(grant, "GET", `${hosts.api}${elsewhere}/apps/${app.id}/ui`),
          }),
        ).toEqual({
          app: 401,
          inventory: 401,
          source: 401,
          account: 401,
          groups: 401,
          mcp: 401,
          git: 401,
          otherOrganization: 403,
        });

        const { binding: bound } = binding();
        expect(
          yield* Effect.all([
            mintStatus(grant, {}),
            mintStatus(grant, { binding: "not-a-digest" }),
            mintStatus(grant, { binding: bound, returnTo: "//evil.example/" }),
            mintStatus(grant, { binding: bound, returnTo: "https://evil.example/" }),
            api
              .request(anonymous, "POST", "/api/auth/desktop/session-link", { binding: bound })
              .pipe(Effect.map((response) => response.status)),
          ]),
        ).toEqual([400, 400, 400, 400, 401]);

        const link = yield* minted(grant, "/?from=desktop");
        const opened = yield* fresh(
          "Open the session link in the desktop's browser context, which holds the binding cookie",
          (context) =>
            context.newPage().then((page) =>
              page
                .setExtraHTTPHeaders({ "x-executor-desktop-link": "1" })
                .then(() => page.goto(reveal(link.url)))
                .then((response) => {
                  let first = response?.request();
                  while (first?.redirectedFrom()) first = first.redirectedFrom() ?? undefined;
                  return (first?.response() ?? Promise.resolve(null)).then((hop) =>
                    Promise.all([
                      context.request
                        .get(`${origin}/api/auth/get-session`)
                        .then((session): Promise<unknown> => session.json()),
                      context.cookies(origin),
                      page.screenshot(),
                    ]).then(([session, cookies, screenshot]) =>
                      page
                        .evaluate(() =>
                          fetch("/api/auth/sign-out", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: "{}",
                          }).then((signedOut) => signedOut.status),
                        )
                        .then((signedOut) =>
                          context.request
                            .get(`${origin}/api/auth/get-session`)
                            .then((after): Promise<unknown> => after.json())
                            .then((after) => ({
                              hop: hop?.status(),
                              location: hop?.headers()["location"],
                              landed: page.url(),
                              session,
                              bindingKept: cookies.some((cookie) => cookie.name === cookieName),
                              screenshot,
                              signedOut,
                              after,
                            })),
                        ),
                    ),
                  );
                }),
            ),
          { verifier: link.verifier },
        );
        yield* evidence.attach("desktop-session-landed.png", "image/png", opened.screenshot);
        expect(opened.hop).toBe(302);
        expect(opened.location).toBe(`${origin}/?from=desktop`);
        expect(new URL(opened.landed).origin).toBe(origin);
        expect(new URL(opened.landed).pathname).not.toBe("/login");
        expect(yield* Schema.decodeUnknownEffect(SessionUser)(opened.session)).toEqual({
          user: { id: owner },
        });
        expect(opened.bindingKept).toBe(false);
        expect(opened.signedOut).toBe(200);
        expect(opened.after).toBeNull();

        const reused = yield* fresh(
          "A used link signs no one in, even with its binding cookie",
          (context) => redeemed(context, link.url),
          { verifier: link.verifier },
        );
        expect(reused).toMatchObject({ ...refused, cacheControl: "no-store" });

        const linkOpenedAsAdmin = yield* minted(grant);
        const crossUser = yield* fresh(
          "A link cannot switch a browser signed in as someone else",
          (context) => redeemed(context, linkOpenedAsAdmin.url),
          { cookies: actors.admin, verifier: linkOpenedAsAdmin.verifier },
        );
        expect(crossUser).toMatchObject({ status: 302, location: `${origin}/login` });
        expect(yield* Schema.decodeUnknownEffect(SessionUser)(crossUser.session)).toEqual({
          user: { id: admin },
        });

        const malformed = yield* fresh("A malformed link is refused the same way", (context) =>
          redeemed(context, secret(`${origin}/api/auth/desktop/session?code=not-a-link`)),
        );
        expect(malformed).toMatchObject(refused);

        const refreshed = yield* oauth.refresh(authorized);
        const refreshedToken = secret(reveal(refreshed.tokens).access_token);
        expect(
          (yield* api.request(
            anonymous,
            "GET",
            `${prefix}/apps/${app.id}/ui`,
            undefined,
            bearer(refreshedToken),
          )).status,
        ).toBe(200);
        const kept = yield* minted(refreshedToken);
        const signedInByLink = yield* fresh(
          "A window the link signs in keeps its session until the desktop is revoked",
          (context) =>
            context.request
              .get(reveal(kept.url), {
                maxRedirects: 0,
                headers: { "x-executor-desktop-link": "1" },
              })
              .then(() => context.cookies(origin))
              .then((cookies) =>
                secret(cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")),
              ),
          { verifier: kept.verifier },
        );
        const sessionOf = (cookie: Token) =>
          http
            .execute(
              HttpClientRequest.get(`${origin}/api/auth/get-session`).pipe(
                HttpClientRequest.setHeaders({ cookie: reveal(cookie) }),
              ),
            )
            .pipe(Effect.flatMap((response) => response.json));
        expect(
          yield* Schema.decodeUnknownEffect(SessionUser)(yield* sessionOf(signedInByLink)),
        ).toEqual({ user: { id: owner } });
        yield* oauth.revoke(refreshed);
        expect(
          yield* Effect.all([
            status(refreshedToken, "GET", `${hosts.api}${prefix}/apps/${app.id}/ui`),
            mintStatus(refreshedToken, { binding: bound }),
          ]),
        ).toEqual([401, 401]);
        expect(yield* sessionOf(signedInByLink)).toBeNull();
        expect((yield* userOf(actors.owner)).user.id).toBe(owner);
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.desktopSessionPinned.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, origin, minted, fresh, desktopToken } = yield* desktopFixture;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name: "Desktop other team",
          slug: `desktop-other-${randomUUID().slice(0, 8)}`,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status).toBe(200);
        const other = yield* body(Schema.Struct({ id: Schema.String }), created);
        expect(
          (yield* api.request(actors.owner, "GET", `/api/organizations/${other.id}/access`)).status,
        ).toBe(200);
        const link = yield* minted(yield* desktopToken(actors.owner));
        const pinned = yield* fresh(
          "A window a desktop link signs in reaches only the organization the desktop was consented to",
          (browser) =>
            browser.request
              .get(reveal(link.url), {
                maxRedirects: 0,
                headers: { "x-executor-desktop-link": "1" },
              })
              .then(() =>
                Promise.all([
                  browser.request
                    .get(`${origin}/api/organizations/${actors.organization.id}/access`)
                    .then((response) => response.status()),
                  browser.request
                    .get(`${origin}/api/organizations/${other.id}/access`)
                    .then((response) => response.status()),
                  browser.request
                    .get(`${origin}/api/auth/organization/list`)
                    .then((response): Promise<unknown> => response.json()),
                  browser.request
                    .post(`${origin}/api/auth/organization/create`, {
                      headers: { origin },
                      data: {
                        name: "Desktop escape",
                        slug: `desktop-escape-${randomUUID().slice(0, 8)}`,
                        keepCurrentActiveOrganization: true,
                      },
                    })
                    .then((response) => response.status()),
                ]),
              ),
          { verifier: link.verifier },
        );
        const listed = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: Schema.String })),
        )(pinned[2]);
        expect({
          own: pinned[0],
          other: pinned[1],
          listed: listed.map((organization) => organization.id),
          create: pinned[3],
        }).toEqual({ own: 200, other: 403, listed: [actors.organization.id], create: 403 });
        expect(
          (yield* api.request(actors.owner, "GET", `/api/organizations/${other.id}/access`)).status,
        ).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.desktopSessionLinkBinding.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          actors,
          origin,
          binding,
          bind,
          mintStatus,
          minted,
          fresh,
          redeemed,
          refused,
          desktopToken,
        } = yield* desktopFixture;
        const browser = yield* Browser;
        const token = yield* desktopToken(actors.owner);

        const lured = yield* minted(token);
        const victim = yield* fresh(
          "A link opened in a browser without its binding cookie is refused",
          (context) => redeemed(context, lured.url),
        );
        expect(victim).toMatchObject(refused);
        const afterLure = yield* fresh(
          "The refused attempt burned the link for the desktop too",
          (context) => redeemed(context, lured.url),
          { verifier: lured.verifier },
        );
        expect(afterLure).toMatchObject(refused);

        const guessed = yield* minted(token);
        const wrong = yield* fresh(
          "A link opened with another verifier is refused",
          (context) => redeemed(context, guessed.url),
          { verifier: secret(binding().verifier) },
        );
        expect(wrong).toMatchObject(refused);
        const afterWrong = yield* fresh(
          "The wrong verifier burned the link",
          (context) => redeemed(context, guessed.url),
          { verifier: guessed.verifier },
        );
        expect(afterWrong).toMatchObject(refused);

        const framed = yield* minted(token);
        const crossSite = yield* fresh(
          "A cross-site request is refused even with the binding cookie",
          (context) =>
            redeemed(context, framed.url, {
              "x-executor-desktop-link": "1",
              "sec-fetch-site": "cross-site",
            }),
          { verifier: framed.verifier },
        );
        expect(crossSite).toMatchObject({ ...refused, bindingKept: true });

        const planted = yield* minted(token);
        const navigated = yield* fresh(
          "A link a page navigates to is refused even with a planted binding cookie",
          (context) => redeemed(context, planted.url, {}),
          { verifier: planted.verifier },
        );
        expect(navigated).toMatchObject({ ...refused, bindingKept: true });
        const afterNavigated = yield* fresh(
          "The page's navigation burned the link",
          (context) => redeemed(context, planted.url),
          { verifier: planted.verifier },
        );
        expect(afterNavigated).toMatchObject(refused);

        const raced = yield* minted(token);
        const both = yield* browser.use(
          "Redeem one link at once from two browsers that both hold its binding cookie",
          (page) => {
            const driver = page.context().browser();
            if (driver === null) return Promise.reject(new Error("No browser to open"));
            return Promise.all([driver.newContext(), driver.newContext()]).then((contexts) =>
              Promise.all(contexts.map((context) => bind(context, raced.verifier)))
                .then(() => Promise.all(contexts.map((context) => redeemed(context, raced.url))))
                .finally(() => Promise.all(contexts.map((context) => context.close()))),
            );
          },
        );
        expect(both.filter((result) => result.session !== null)).toHaveLength(1);
        expect(both.map((result) => result.location).toSorted()).toEqual(
          [`${origin}/`, `${origin}/login`].toSorted(),
        );

        const { binding: bound } = binding();
        const encodings = [
          "/api",
          "/api/x",
          "/a/../api/x",
          "/.//evil.example",
          "/\\evil.example",
          "/%2F%2Fevil.example",
          "/%5Cevil.example",
          "/\t/evil.example",
        ];
        expect(
          yield* Effect.forEach(encodings, (returnTo) =>
            mintStatus(token, { binding: bound, returnTo }).pipe(
              Effect.map((status) => [returnTo, status] as const),
            ),
          ),
        ).toEqual(encodings.map((returnTo) => [returnTo, 400]));
        expect(yield* mintStatus(token, { binding: bound, returnTo: "/apps?tab=all#top" })).toBe(
          200,
        );
      }),
    ),
  );

  it.effect(scenarios.desktopGrantBoundaries.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          hosts,
          resourceOrigin,
          anonymous,
          bearer,
          binding,
          mintStatus,
          consentDesktop,
          desktopToken,
        } = yield* desktopFixture;
        const { app } = yield* managementApp(actors.owner);
        const prefix = `/api/organizations/${actors.organization.id}`;

        const redirects = {
          https: ["https://desktop.e2e.invalid/callback"],
          mixed: [loopback, "https://desktop.e2e.invalid/callback"],
          localhost: ["http://localhost:9/callback"],
          lookalike: ["http://localhost.evil.example:9/callback"],
          httpsLoopback: ["https://127.0.0.1:9/callback"],
          ipv4: [loopback],
          ipv6: ["http://[::1]:9/callback"],
        } as const;
        const outcomes = yield* Effect.forEach(Object.entries(redirects), ([name, list]) =>
          consentDesktop(actors.owner, list).pipe(
            Effect.map((consent) => [name, consent.outcome] as const),
          ),
        );
        expect(Object.fromEntries(outcomes)).toEqual({
          https: "consent refused",
          mixed: "consent refused",
          localhost: "consent refused",
          lookalike: "registration refused",
          httpsLoopback: "registration refused",
          ipv4: "granted",
          ipv6: "granted",
        });

        const organization = { "x-executor-organization": actors.organization.id };
        const apiToken = yield* (yield* consentTo(
          actors.owner,
          `${resourceOrigin}/api`,
          organization,
          "executor offline_access",
        )).tokens;
        const mcpToken = yield* (yield* consentTo(actors.owner, `${hosts.mcp}/mcp`, organization))
          .tokens;
        const { binding: bound } = binding();
        expect(
          yield* Effect.all({
            apiMint: mintStatus(apiToken, { binding: bound }),
            mcpMint: mintStatus(mcpToken, { binding: bound }),
            apiReadsApp: api
              .request(anonymous, "GET", `${prefix}/apps/${app.id}`, undefined, bearer(apiToken))
              .pipe(Effect.map((response) => response.status)),
          }),
        ).toEqual({ apiMint: 401, mcpMint: 401, apiReadsApp: 200 });

        const memberToken = yield* desktopToken(actors.member);
        expect(yield* mintStatus(memberToken, { binding: bound })).toBe(200);
        const member = yield* body(
          Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }),
          yield* api.request(actors.member, "GET", "/api/auth/get-session"),
        );
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: member.user.email,
          })).status,
        ).toBe(200);
        expect(yield* mintStatus(memberToken, { binding: bound })).toBe(403);
      }),
    ),
  );

  it.effect(scenarios.desktopSessionLinkExpiry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, minted, fresh, redeemed, refused, desktopToken } = yield* desktopFixture;
        const link = yield* minted(yield* desktopToken(actors.owner));
        expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(2000);
        yield* Effect.sleep("3 seconds");
        const expired = yield* fresh(
          "An expired link signs no one in, even with its binding cookie",
          (context) => redeemed(context, link.url),
          { verifier: link.verifier },
        );
        expect(expired).toMatchObject(refused);
      }),
    ),
  );
});
