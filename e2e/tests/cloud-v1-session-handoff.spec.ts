/**
 * v1 session handoff: v1's dashboard redirects a signed-in member of a workspace that has moved to
 * v2's `/api/v1-handoff` with a token it signs for that member, and v2 starts its own session for
 * the user the import mapped them to (`notes/v1-shutdown.md`, Forwarding). The scenarios record
 * the scenario's organization and two of its members as a moved v1 workspace, as the import did,
 * then sign tokens as v1 does with the secret the managed Cloud shares with its synthetic v1.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { writeRows } from "../support/cloud-rows.ts";
import { driver, Target } from "../support/platform.ts";
import { waitForLastOrganization } from "../support/organization-entry.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { recordMovedV1Organization, v1OrganizationId, v1UserId } from "../support/v1-moved.ts";
import {
  V1SessionHandoffSecret,
  v1HandoffId,
  v1HandoffToken,
  v1SessionHandoffFile,
  type V1HandoffClaims,
} from "../support/v1-session-handoff.ts";
import { scenarios } from "../test-plan.ts";

const Created = Schema.Struct({ id: Schema.String, slug: Schema.String });

const Session = Schema.NullOr(Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }));
const Identity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
});

/** The v2 user a session belongs to. */
const userOf = (session: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* body(Identity, yield* api.request(session, "GET", "/api/auth/get-session")))
      .user;
  });

/**
 * A two-member v1 workspace that moved to the scenario's organization, recorded as the import
 * recorded it: the organization and both members, the owner and a member, mapped to their v2
 * users. The browser is signed in as neither.
 */
const movedWorkspace = Effect.gen(function* () {
  const actors = yield* Actors,
    fs = yield* FileSystem.FileSystem,
    target = yield* Target;
  const { secret } = yield* fs
    .readFileString(`${target.directory}/${v1SessionHandoffFile}`)
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1SessionHandoffSecret))),
    );
  const [owner, member] = yield* Effect.all([userOf(actors.owner), userOf(actors.member)]);
  const v1 = { organization: v1OrganizationId(), owner: v1UserId(), member: v1UserId() };
  yield* recordMovedV1Organization({
    v1Organization: v1.organization,
    v2Organization: actors.organization.id,
    users: [
      { v1: v1.owner, v2: owner.id },
      { v1: v1.member, v2: member.id },
    ],
  });
  const moved = actors.organization;
  /** A token as v1 signs it for one handoff, a minute long. */
  const sign = (claims: Partial<V1HandoffClaims> = {}, signedWith = secret) => {
    const now = Math.floor(Date.now() / 1000);
    return v1HandoffToken(signedWith, {
      user: v1.owner,
      organization: v1.organization,
      slug: moved.slug,
      iat: now,
      exp: now + 60,
      jti: v1HandoffId(),
      ...claims,
    });
  };
  return {
    sign,
    slug: moved.slug,
    v2Organization: moved.id,
    owner: { user: v1.owner, v2: owner.id, email: owner.email },
    member: { user: v1.member, v2: member.id, email: member.email },
  };
});

const handoffPath = (token: string) => `/api/v1-handoff?token=${encodeURIComponent(token)}`;
const signInFor = (slug: string) => `/login?redirect=${encodeURIComponent(`/org/${slug}`)}`;

/** One handoff request from a browser with no session, without following its redirect. */
const signedOut = (token: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const url = `${targetHosts(target).browser}${handoffPath(token)}`;
    return yield* driver("Open a v1 handoff signed out", (signal) =>
      fetch(url, { redirect: "manual", signal }).then((response) =>
        response.text().then(() => ({
          status: response.status,
          location: response.headers.get("location"),
          referrerPolicy: response.headers.get("referrer-policy"),
          cookies: response.headers.getSetCookie().length,
        })),
      ),
    );
  });

/** One handoff request from the signed-in browser, with its cookies, without following it. */
const fromBrowser = (step: string, token: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser.use(step, (page) =>
      page
        .context()
        .request.get(handoffPath(token), { maxRedirects: 0 })
        .then((response) => ({
          status: response.status(),
          location: response.headers()["location"] ?? null,
          cookies: response.headersArray().filter((header) => header.name === "set-cookie").length,
        })),
    );
  });

/** The email of the browser's v2 session, or null when it has none. */
const sessionEmail = (step: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const session = yield* browser
      .use(step, (page) =>
        page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
    return session?.user.email ?? null;
  });

layer(HostedLive, { excludeTestServices: true })("Cloud v1 session handoff", (it) => {
  it.effect(scenarios.v1HandoffSignIn.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const moved = yield* movedWorkspace;
        const token = moved.sign();

        // The browser follows the redirects; the handoff's own response is the first of them.
        const handoff = yield* browser.use("Open the handoff v1 redirects to", (page) =>
          page.goto(handoffPath(token)).then((response) => {
            let request = response?.request() ?? null;
            while (request !== null && new URL(request.url()).pathname !== "/api/v1-handoff")
              request = request.redirectedFrom();
            return request?.response() ?? null;
          }),
        );
        if (handoff === null) return yield* Effect.die("The handoff did not redirect");
        const headers = yield* browser.use("Read the handoff's response", () =>
          handoff.headersArray(),
        );
        const header = (name: string) =>
          headers.filter((entry) => entry.name.toLowerCase() === name).map((entry) => entry.value);
        const landed = yield* browser.use(
          "The handoff opens the organization's dashboard",
          (page) =>
            page
              .getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ })
              .waitFor({ state: "visible" })
              .then(() => new URL(page.url()).pathname),
        );
        expect(landed.startsWith(`/org/${moved.slug}/`)).toBe(true);
        const opened = {
          status: handoff.status(),
          location: header("location")[0],
          referrerPolicy: header("referrer-policy")[0],
          cacheControl: header("cache-control")[0],
          sessionCookie: header("set-cookie").length,
        };
        expect(opened).toMatchObject({
          status: 302,
          location: `/org/${moved.slug}`,
          referrerPolicy: "no-referrer",
          cacheControl: "no-store",
        });
        expect(opened.sessionCookie).toBeGreaterThan(0);
        expect(yield* sessionEmail("Read the session the handoff started")).toBe(moved.owner.email);
        yield* browser.checkpoint("signed in through the v1 handoff");

        // Signed in as the same user, a new handoff only redirects.
        expect(yield* fromBrowser("Hand off the same user again", moved.sign())).toEqual({
          status: 302,
          location: `/org/${moved.slug}`,
          cookies: 0,
        });

        // v1 names its own session's organization; v2 opens the one this browser used last.
        const secondSlug = `${moved.slug}-second`;
        const created = yield* browser.use("Create a second organization", (page) =>
          page
            .context()
            .request.post("/api/auth/organization/create", {
              headers: { origin: new URL(page.url()).origin },
              data: {
                name: "Second organization",
                slug: secondSlug,
                keepCurrentActiveOrganization: true,
              },
            })
            .then((response) =>
              response.json().then((body) => ({ status: response.status(), body })),
            ),
        );
        expect(created.status).toBe(200);
        const second = yield* Schema.decodeUnknownEffect(Created)(created.body);
        yield* browser.use("Work in the second organization", (page) =>
          page.goto(`/org/${second.slug}/apps`),
        );
        yield* waitForLastOrganization(second.id);
        expect(
          yield* fromBrowser("Hand off after working in the second organization", moved.sign()),
        ).toEqual({ status: 302, location: `/org/${second.slug}`, cookies: 0 });

        // A remembered organization the user no longer belongs to falls back to the token's.
        yield* browser.use("Remember an organization the user is not a member of", (page) =>
          page
            .context()
            .cookies()
            .then((cookies) => {
              const cookie = cookies.find((value) => value.name.startsWith("executor-org"));
              if (cookie === undefined) throw new Error("The organization memory is missing");
              return page.context().addCookies([
                {
                  ...cookie,
                  value: encodeURIComponent(
                    JSON.stringify({
                      ...JSON.parse(decodeURIComponent(cookie.value)),
                      organization: "missing-handoff-test-organization",
                    }),
                  ),
                },
              ]);
            }),
        );
        expect(yield* fromBrowser("Hand off with a stale memory", moved.sign())).toEqual({
          status: 302,
          location: `/org/${moved.slug}`,
          cookies: 0,
        });

        // Another user's handoff never replaces the session the browser holds.
        expect(
          yield* fromBrowser(
            "Hand off another member to the signed-in browser",
            moved.sign({ user: moved.member.user }),
          ),
        ).toEqual({ status: 302, location: signInFor(moved.slug), cookies: 0 });
        expect(yield* sessionEmail("The browser keeps its own session")).toBe(moved.owner.email);

        // The token is used: replayed from anywhere, it opens sign-in and starts no session.
        expect(yield* signedOut(token)).toEqual({
          status: 302,
          location: signInFor(moved.slug),
          referrerPolicy: "no-referrer",
          cookies: 0,
        });
      }),
    ),
  );

  it.effect(scenarios.v1HandoffRefusals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const moved = yield* movedWorkspace;
        const now = Math.floor(Date.now() / 1000);
        const refused = {
          status: 302,
          location: signInFor(moved.slug),
          referrerPolicy: "no-referrer",
          cookies: 0,
        };
        // Not signed by v1, expired, longer-lived than v1 makes them, or for another audience.
        expect(yield* signedOut(moved.sign({}, "x".repeat(64)))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ iat: now - 120, exp: now - 60 }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ exp: now + 3_600 }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ aud: "v2-mcp-forward" }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ v: 2 }))).toEqual(refused);
        // A WorkOS user the import never mapped, even one in no other workspace.
        expect(yield* signedOut(moved.sign({ user: `user_${randomUUID()}` }))).toEqual(refused);
        // The organization's slug claimed for a v1 organization that was not imported as it.
        expect(yield* signedOut(moved.sign({ organization: `org_${randomUUID()}` }))).toEqual(
          refused,
        );
        // The endpoint that starts the session is server-only: over HTTP it does not exist, even
        // for the mapped user and their organization.
        const direct = yield* Effect.gen(function* () {
          const target = yield* Target;
          const url = `${targetHosts(target).browser}/api/auth/v1-handoff/session`;
          return yield* driver("Call the handoff's session endpoint directly", (signal) =>
            fetch(url, {
              method: "POST",
              redirect: "manual",
              signal,
              headers: { "content-type": "application/json", origin: targetHosts(target).browser },
              body: JSON.stringify({
                userId: moved.owner.v2,
                organizationId: moved.v2Organization,
              }),
            }).then((response) =>
              response.text().then(() => ({
                status: response.status,
                cookies: response.headers.getSetCookie().length,
              })),
            ),
          );
        });
        expect(direct).toEqual({ status: 404, cookies: 0 });
        // A member who has left the v2 organization since it moved.
        yield* writeRows("sso-database.json", [
          {
            sql: `delete from member where "organizationId" = $1 and "userId" = (select v2_id from private_v1_import_map where v1_kind = 'user' and v1_id = $2) returning id`,
            params: [moved.v2Organization, moved.member.user],
          },
        ]).pipe(Effect.map((rows) => expect(rows[0]).toHaveLength(1)));
        expect(yield* signedOut(moved.sign({ user: moved.member.user }))).toEqual(refused);
        // The workspace itself hands off: what was refused was each token.
        const accepted = yield* signedOut(moved.sign());
        expect(accepted).toMatchObject({
          status: 302,
          location: `/org/${moved.slug}`,
          referrerPolicy: "no-referrer",
        });
        expect(accepted.cookies).toBeGreaterThan(0);
      }),
    ),
  );
});
