import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Organization } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { batchPath } from "../support/read-batches.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const Answer = Schema.Struct({
  id: Schema.Int,
  status: Schema.Int,
  text: Schema.optional(Schema.String),
});
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(Answer));
const Viewer = Schema.Struct({ userId: Schema.String });
const Access = Schema.Struct({ role: Schema.String });
const Key = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Roster = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});

interface Read {
  readonly group: string;
  readonly endpoint: string;
  readonly params: Readonly<Record<string, string>>;
}
const read = (group: string, endpoint: string, params: Record<string, string> = {}): Read => ({
  group,
  endpoint,
  params,
});

/** Send one batch with an actor's cookies, plus any extra headers, and return answers in read order. */
const send = (
  session: Session,
  reads: ReadonlyArray<Read>,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const origin = targetHosts(yield* Target).browser;
      const cookies = Redacted.value(yield* session.cookies);
      const response = yield* client.execute(
        yield* HttpClientRequest.post(new URL(batchPath, origin)).pipe(
          HttpClientRequest.setHeaders({
            origin,
            cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
            "executor-wire-revision": "1",
            ...headers,
          }),
          HttpClientRequest.bodyJson({
            reads: reads.map((entry, id) => ({ ...entry, id, query: {} })),
          }),
        ),
      );
      expect(response.status).toBe(200);
      const text = yield* response.text;
      const answers = yield* Effect.forEach(text.trim().split("\n"), (line) => decodeAnswer(line));
      expect(answers).toHaveLength(reads.length);
      return answers.toSorted((left, right) => left.id - right.id);
    }),
  );

/** The URL each read has as a request of its own. */
const paths: Readonly<Record<string, (params: Readonly<Record<string, string>>) => string>> = {
  "viewer.get": () => "/api/viewer",
  "organization.access": ({ organization }) => `/api/organizations/${organization}/access`,
  "oauthClients.list": ({ organization }) => `/api/organizations/${organization}/oauth-clients`,
};

/** Send each read alone, with the same cookies and headers, and return its status. */
const alone = (
  session: Session,
  reads: ReadonlyArray<Read>,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const origin = targetHosts(yield* Target).browser;
    const cookies = Redacted.value(yield* session.cookies);
    return yield* Effect.forEach(reads, (entry) => {
      const path = paths[`${entry.group}.${entry.endpoint}`];
      if (path === undefined) return Effect.die(`No path for ${entry.group}.${entry.endpoint}`);
      return Effect.scoped(
        client
          .execute(
            HttpClientRequest.get(new URL(path(entry.params), origin)).pipe(
              HttpClientRequest.setHeaders({
                cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
                ...headers,
              }),
            ),
          )
          .pipe(Effect.map(({ status }) => status)),
      );
    });
  });

const statuses = (answers: ReadonlyArray<typeof Answer.Type>) =>
  answers.map(({ status }) => status);
const viewerOf = (answer: typeof Answer.Type | undefined) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Viewer))(answer?.text ?? "");
const roleOf = (answer: typeof Answer.Type | undefined) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Access))(answer?.text ?? "").pipe(
    Effect.map(({ role }) => role),
  );

/** A fixed shuffle per round, so concurrent reads start in a different order each time. */
const rotate = <A>(items: ReadonlyArray<A>, by: number) =>
  items.map((_, index) => items[(index + by) % items.length] as A);

layer(HostedLive, { excludeTestServices: true })("Dashboard batch isolation", (it) => {
  it.effect(scenarios.dashboardBatchIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const cloud = (yield* Target).metadata.target === "cloud";
        const home = actors.organization;
        const viewers = {
          owner: yield* body(Viewer, yield* api.request(actors.owner, "GET", "/api/viewer")),
          member: yield* body(Viewer, yield* api.request(actors.member, "GET", "/api/viewer")),
        };

        // Concurrent batches from different callers each see only their own identity and role.
        const identity = [
          read("viewer", "get"),
          read("organization", "access", { organization: home.id }),
          read("oauthClients", "list", { organization: home.id }),
        ];
        yield* Effect.forEach(
          Array.from({ length: 6 }, (_, round) => round),
          (round) =>
            Effect.all(
              [
                send(actors.owner, rotate(identity, round)),
                send(actors.member, rotate(identity, round)),
              ],
              { concurrency: "unbounded" },
            ).pipe(
              Effect.flatMap(([owner, member]) =>
                Effect.gen(function* () {
                  const order = rotate([0, 1, 2], round);
                  const at = (answers: typeof owner, index: number) =>
                    answers[order.indexOf(index)];
                  expect((yield* viewerOf(at(owner, 0))).userId).toBe(viewers.owner.userId);
                  expect(yield* roleOf(at(owner, 1))).toBe("owner");
                  expect(at(owner, 2)?.status).toBe(200);
                  expect((yield* viewerOf(at(member, 0))).userId).toBe(viewers.member.userId);
                  expect(yield* roleOf(at(member, 1))).toBe("member");
                  expect(at(member, 2)?.status).toBe(403);
                }),
              ),
            ),
          { concurrency: 3, discard: true },
        );

        // A bearer grant never uses the batch's shared session checks. Whatever the cookie beside
        // it, even another user's, every read answers exactly as it does sent alone with the same
        // headers: the API key's authority on organization reads, and a refusal on browser-only ones.
        const key = yield* body(
          Key,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Batch isolation",
            metadata: { organization: home.id },
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const bearer = { authorization: `Bearer ${Redacted.value(key.key)}` };
        for (const caller of [actors.owner, actors.member, yield* api.session()]) {
          const batched = statuses(yield* send(caller, identity, bearer));
          expect(batched).toEqual(yield* alone(caller, identity, bearer));
          expect(batched[0]).toBe(401);
        }

        // A role change between batches is read by the next batch.
        const roster = yield* body(
          Roster,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${home.id}`,
          ),
        );
        const membership = roster.members.find(({ userId }) => userId === viewers.member.userId);
        if (membership === undefined)
          return yield* Effect.die("The member's membership is missing");
        const setRole = (role: "admin" | "member") =>
          api
            .request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
              organizationId: home.id,
              memberId: membership.id,
              role,
            })
            .pipe(Effect.map((response) => expect(response.status).toBe(200)));
        yield* setRole("admin");
        const promoted = yield* send(actors.member, identity);
        expect(yield* roleOf(promoted[1])).toBe("admin");
        expect(promoted[2]?.status).toBe(200);
        yield* setRole("member");
        const demoted = yield* send(actors.member, identity);
        expect(yield* roleOf(demoted[1])).toBe("member");
        expect(demoted[2]?.status).toBe(403);

        if (!cloud) return;
        // Self-host has one organization. On Cloud, one batch spans organizations where the caller
        // has different roles, one it does not belong to, and aliases of each.
        const suffix = randomUUID().slice(0, 8);
        const foreign = yield* body(
          Organization,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
            name: "Batch isolation foreign",
            slug: `batch-foreign-${suffix}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `/api/organizations/${foreign.id}`)
            .pipe(Effect.orDie),
        );
        const own = yield* body(
          Organization,
          yield* api.request(actors.member, "POST", "/api/auth/organization/create", {
            name: "Batch isolation own",
            slug: `batch-own-${suffix}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.member, "DELETE", `/api/organizations/${own.id}`).pipe(Effect.orDie),
        );
        const mixed = [
          read("organization", "access", { organization: home.id }),
          read("oauthClients", "list", { organization: home.id }),
          read("organization", "access", { organization: foreign.id }),
          read("oauthClients", "list", { organization: foreign.id }),
          read("organization", "access", { organization: own.id }),
          read("oauthClients", "list", { organization: own.id }),
          read("organization", "access", { organization: home.slug }),
          read("organization", "access", { organization: foreign.slug }),
          read("organization", "access", { organization: own.slug }),
          read("oauthClients", "list", { organization: foreign.slug }),
        ];
        const expected = [200, 403, 403, 403, 200, 200, 200, 403, 200, 403];
        for (let round = 0; round < mixed.length; round++) {
          const order = rotate(
            mixed.map((_, index) => index),
            round,
          );
          const answers = yield* send(
            actors.member,
            order.map((index) => mixed[index] as Read),
          );
          // Answers come back by position sent; map each to the read it answers.
          const of = (index: number) => answers[order.indexOf(index)];
          expect(mixed.map((_, index) => of(index)?.status)).toEqual(expected);
          const roles = yield* Effect.forEach([0, 4, 6, 8], (index) => roleOf(of(index)));
          expect(roles).toEqual(["member", "owner", "member", "owner"]);
        }
        // The owner's batch on the same organizations is answered with the owner's roles.
        const owner = yield* send(actors.owner, mixed);
        expect(statuses(owner)).toEqual([200, 200, 200, 200, 403, 403, 200, 200, 403, 200]);
      }),
    ),
  );
});
