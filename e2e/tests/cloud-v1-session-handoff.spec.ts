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

const userOf = (session: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* body(Identity, yield* api.request(session, "GET", "/api/auth/get-session")))
      .user;
  });

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

        expect(yield* fromBrowser("Hand off the same user again", moved.sign())).toEqual({
          status: 302,
          location: `/org/${moved.slug}`,
          cookies: 0,
        });

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

        expect(
          yield* fromBrowser(
            "Hand off another member to the signed-in browser",
            moved.sign({ user: moved.member.user }),
          ),
        ).toEqual({ status: 302, location: signInFor(moved.slug), cookies: 0 });
        expect(yield* sessionEmail("The browser keeps its own session")).toBe(moved.owner.email);

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
        expect(yield* signedOut(moved.sign({}, "x".repeat(64)))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ iat: now - 120, exp: now - 60 }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ exp: now + 3_600 }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ aud: "v2-mcp-forward" }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ v: 2 }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ user: `user_${randomUUID()}` }))).toEqual(refused);
        expect(yield* signedOut(moved.sign({ organization: `org_${randomUUID()}` }))).toEqual(
          refused,
        );
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
        yield* writeRows("sso-database.json", [
          {
            sql: `delete from member where "organizationId" = $1 and "userId" = (select v2_id from private_v1_import_map where v1_kind = 'user' and v1_id = $2) returning id`,
            params: [moved.v2Organization, moved.member.user],
          },
        ]).pipe(Effect.map((rows) => expect(rows[0]).toHaveLength(1)));
        expect(yield* signedOut(moved.sign({ user: moved.member.user }))).toEqual(refused);
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
