/**
 * MCP and API bearer authentication accepts exactly the stored states Better Auth's token and
 * key verification and the hosted grant rules accept. Each case changes one stored field of
 * an otherwise valid credential, in the shape a current, older or operator-edited row could
 * hold, and checks the request is refused or accepted. Every changed row is a copy this
 * scenario owns: the Cloud database is shared, so shared OAuth resources are never edited.
 */
import { createHash, randomBytes } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
type Param = string | number | boolean | null;
interface Statement {
  readonly sql: string;
  readonly params?: ReadonlyArray<Param>;
}
/** Better Auth stores opaque tokens and keys as the unpadded base64url SHA-256. */
const hashed = (credential: string) => createHash("sha256").update(credential).digest("base64url");
const unique = (prefix: string) => `${prefix}${randomBytes(8).toString("hex")}`;
/** Copy a row, replacing the given columns, so a case owns every row it changes. */
const copy = (
  table: string,
  where: string,
  overrides: Record<string, unknown>,
  params: Param[],
) => ({
  sql: `insert into "${table}" select (jsonb_populate_record(null::"${table}",
    to_jsonb(r) || $1::jsonb)).* from "${table}" r where ${where}`,
  params: [JSON.stringify(overrides), ...params],
});

layer(HostedLive, { excludeTestServices: true })("Bearer authentication refusals", (it) => {
  it.effect(scenarios.bearerAuthRefusals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          target = yield* Target,
          oauth = yield* McpOAuth,
          fs = yield* FileSystem.FileSystem,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner,
          http = yield* HttpClient.HttpClient;
        const origin = target.metadata.origin;
        const organization = actors.organization.id;

        /** Apply statements in one transaction against the managed Cloud's own database. */
        const rows = (statements: ReadonlyArray<Statement>) =>
          Effect.gen(function* () {
            const file = `${target.directory}/bearer-rows-${randomBytes(6).toString("hex")}.json`;
            yield* fs.writeFileString(file, JSON.stringify(statements), { mode: 0o600 });
            const output = yield* processes
              .string(
                ChildProcess.make(
                  "node",
                  [
                    "apps/hosted/testing/cloud-rows-fixture.ts",
                    "--configuration",
                    `${target.directory}/sso-database.json`,
                    "--statements",
                    file,
                  ],
                  { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
                ),
              )
              .pipe(Effect.ensuring(fs.remove(file).pipe(Effect.ignore)));
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Array(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
              ),
            )(output);
          });

        /** Only the status: an accepted MCP response may be a stream. */
        const status = (path: string, bearer: string, headers: Record<string, string> = {}) =>
          Effect.scoped(
            Effect.gen(function* () {
              const request = path.startsWith("/api/")
                ? HttpClientRequest.get(`${origin}${path}`)
                : HttpClientRequest.post(`${origin}${path}`).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      jsonrpc: "2.0",
                      id: 1,
                      method: "initialize",
                      params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "Bearer refusals", version: "1.0.0" },
                      },
                    }),
                  );
              const response = yield* http.execute(
                request.pipe(
                  HttpClientRequest.setHeaders({
                    authorization: `Bearer ${bearer}`,
                    accept: "application/json, text/event-stream",
                    ...headers,
                  }),
                ),
              );
              return response.status;
            }),
          ).pipe(Effect.timeout("30 seconds"), Effect.orDie);

        const owned = {
          tokens: [] as string[],
          grants: [] as string[],
          clients: [] as string[],
          sessions: [] as string[],
          connections: [] as string[],
          resources: [] as string[],
          organizations: [] as string[],
          keys: [] as string[],
        };
        yield* Effect.addFinalizer(() =>
          rows([
            {
              sql: `delete from "oauthAccessToken" where "referenceId" = any($1::text[])`,
              params: [`{${owned.grants.join(",")}}`],
            },
            {
              sql: `delete from "oauthConsent" where "referenceId" = any($1::text[])`,
              params: [`{${owned.grants.join(",")}}`],
            },
            {
              sql: `delete from "mcpGrant" where id = any($1::text[])`,
              params: [`{${owned.grants.join(",")}}`],
            },
            {
              sql: `delete from "mcpConnection" where id = any($1::text[])`,
              params: [`{${owned.connections.join(",")}}`],
            },
            {
              sql: `delete from "oauthResource" where identifier = any($1::text[])`,
              params: [`{${owned.resources.map((value) => JSON.stringify(value)).join(",")}}`],
            },
            {
              sql: `delete from "oauthClient" where "clientId" = any($1::text[])`,
              params: [`{${owned.clients.join(",")}}`],
            },
            {
              sql: `delete from session where id = any($1::text[])`,
              params: [`{${owned.sessions.join(",")}}`],
            },
            {
              sql: `delete from member where "organizationId" = any($1::text[])`,
              params: [`{${owned.organizations.join(",")}}`],
            },
            {
              sql: `delete from organization where id = any($1::text[])`,
              params: [`{${owned.organizations.join(",")}}`],
            },
            {
              sql: `delete from apikey where id = any($1::text[])`,
              params: [`{${owned.keys.join(",")}}`],
            },
          ]).pipe(Effect.orDie),
        );

        const memberSession = yield* api.request(actors.member, "GET", "/api/auth/get-session");
        const memberId = (yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          memberSession,
        )).user.id;

        yield* browser.login(actors.owner);
        const mcpGrant = yield* evidence.step(
          "Authorize an MCP grant in the browser",
          oauth.authorize,
        );
        const issued = (yield* rows([
          {
            sql: `select t.id, t."sessionId", t."clientId", t."userId", g.id as "grant"
              from "oauthAccessToken" t join "mcpGrant" g on g.id = t."referenceId"
              where t.token = $1`,
            params: [hashed(Redacted.value(mcpGrant.tokens).access_token)],
          },
        ]))[0]?.[0];
        const Issued = Schema.Struct({
          sessionId: Schema.String,
          clientId: Schema.String,
          userId: Schema.String,
          grant: Schema.String,
        });
        const source = yield* Schema.decodeUnknownEffect(Issued)(issued);

        // Organizations this scenario owns: one where the owner holds an unknown role, one the
        // owner is not a member of, and two whose ID and slug make one reference ambiguous.
        const unknownRole = unique("org-role-"),
          notMember = unique("org-none-"),
          ambiguous = unique("amb-"),
          ambiguousById = ambiguous,
          ambiguousBySlug = unique("org-slug-");
        owned.organizations.push(unknownRole, notMember, ambiguousById, ambiguousBySlug);
        const organizationCopy = (id: string, slug: string) =>
          copy("organization", "r.id = $2", { id, slug, name: `Bearer refusals ${slug}` }, [
            organization,
          ]);
        yield* rows([
          organizationCopy(unknownRole, unknownRole),
          organizationCopy(notMember, notMember),
          organizationCopy(ambiguousById, unique("org-id-")),
          organizationCopy(ambiguousBySlug, ambiguous),
          copy(
            "member",
            `r."organizationId" = $2 and r."userId" = $3`,
            { id: unique("member-"), organizationId: unknownRole, role: "guest" },
            [organization, source.userId],
          ),
        ]);

        /**
         * A copy of the issued token with its own grant and consent (and connection, client or
         * session when the case needs one), then the case's change to that copy.
         */
        const oauthCase = (
          change: (ids: {
            readonly token: string;
            readonly grant: string;
            readonly connection: string;
          }) => ReadonlyArray<Statement>,
          options: {
            readonly client?: boolean;
            readonly session?: boolean;
            readonly connection?: boolean;
          } = {},
        ) =>
          Effect.gen(function* () {
            const token = unique("synthetic-"),
              grant = unique("grant-"),
              connection = unique("conn-");
            const client = options.client === true ? unique("client-") : source.clientId;
            const session = options.session === true ? unique("session-") : source.sessionId;
            const resource =
              options.connection === true
                ? `${origin}/mcp?connection=${connection}`
                : `${origin}/mcp`;
            owned.grants.push(grant);
            if (options.client === true) owned.clients.push(client);
            if (options.session === true) owned.sessions.push(session);
            if (options.connection === true) {
              owned.connections.push(connection);
              owned.resources.push(resource);
            }
            yield* rows([
              ...(options.client === true
                ? [
                    copy(
                      "oauthClient",
                      `r."clientId" = $2`,
                      { id: unique("client-row-"), clientId: client },
                      [source.clientId],
                    ),
                  ]
                : []),
              ...(options.session === true
                ? [
                    copy("session", "r.id = $2", { id: session, token: unique("session-token-") }, [
                      source.sessionId,
                    ]),
                  ]
                : []),
              ...(options.connection === true
                ? [
                    {
                      sql: `insert into "mcpConnection" (id, "userId", resource, name, policy, revoked, "createdAt", "updatedAt")
                        values ($1, $2, $3, 'Bearer refusals', '{"apps":[]}', false, now(), now())`,
                      params: [connection, source.userId, organization],
                    },
                    copy(
                      "oauthResource",
                      "r.identifier = $2",
                      { id: unique("resource-"), identifier: resource },
                      [`${origin}/mcp`],
                    ),
                  ]
                : []),
              copy(
                "mcpGrant",
                "r.id = $2",
                {
                  id: grant,
                  clientId: client,
                  ...(options.connection === true ? { connection } : {}),
                },
                [source.grant],
              ),
              copy(
                "oauthConsent",
                `r."referenceId" = $2`,
                {
                  id: unique("consent-"),
                  referenceId: grant,
                  clientId: client,
                  resources: [resource],
                },
                [source.grant],
              ),
              copy(
                "oauthAccessToken",
                `r.token = $2`,
                {
                  id: unique("token-"),
                  token: hashed(token),
                  referenceId: grant,
                  clientId: client,
                  sessionId: session,
                  resources: [resource],
                  refreshId: null,
                  authorizationCodeId: null,
                },
                [hashed(Redacted.value(mcpGrant.tokens).access_token)],
              ),
              ...change({ token: hashed(token), grant, connection }),
            ]);
            return {
              token,
              path: options.connection === true ? `/mcp?connection=${connection}` : "/mcp",
            };
          });
        const tokenUpdate =
          (set: string, ...params: Param[]) =>
          (ids: { readonly token: string }) => [
            {
              sql: `update "oauthAccessToken" set ${set} where token = $1`,
              params: [ids.token, ...params],
            },
          ];
        const grantUpdate =
          (set: string, ...params: Param[]) =>
          (ids: { readonly grant: string }) => [
            { sql: `update "mcpGrant" set ${set} where id = $1`, params: [ids.grant, ...params] },
          ];
        const consentUpdate =
          (set: string, ...params: Param[]) =>
          (ids: { readonly grant: string }) => [
            {
              sql: `update "oauthConsent" set ${set} where "referenceId" = $1`,
              params: [ids.grant, ...params],
            },
          ];
        const outcomes: Array<{
          readonly name: string;
          readonly status: number;
          readonly expected: ReadonlyArray<number>;
        }> = [];
        // Every case runs before the assertion, so a failure lists the whole table.
        const expectStatus = (name: string, observed: number, expected: ReadonlyArray<number>) =>
          Effect.sync(() => {
            outcomes.push({ name, status: observed, expected });
          });
        const accepted = [200];
        const unauthorized = [401];
        const forbidden = [403];

        yield* evidence.step(
          "OAuth tokens are refused when Better Auth's token check refuses them",
          Effect.gen(function* () {
            const cases: ReadonlyArray<
              readonly [
                string,
                Effect.Effect<{ token: string; path: string }>,
                ReadonlyArray<number>,
              ]
            > = [
              ["unchanged copy", oauthCase(() => []).pipe(Effect.orDie), accepted],
              [
                "expires in an hour",
                oauthCase(tokenUpdate(`"expiresAt" = now() + interval '1 hour'`)).pipe(
                  Effect.orDie,
                ),
                accepted,
              ],
              [
                "expired one second ago",
                oauthCase(tokenUpdate(`"expiresAt" = now() - interval '1 second'`)).pipe(
                  Effect.orDie,
                ),
                unauthorized,
              ],
              [
                "revoked",
                oauthCase(tokenUpdate(`revoked = now()`)).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "client disabled",
                oauthCase(
                  (ids) => [
                    {
                      sql: `update "oauthClient" set disabled = true where "clientId" =
                        (select "clientId" from "mcpGrant" where id = $1)`,
                      params: [ids.grant],
                    },
                  ],
                  { client: true },
                ).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "session expired",
                oauthCase(
                  (ids) => [
                    {
                      sql: `update session set "expiresAt" = now() - interval '1 second' where id =
                        (select "sessionId" from "oauthAccessToken" where token = $1)`,
                      params: [ids.token],
                    },
                  ],
                  { session: true },
                ).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "sender-constrained (cnf)",
                oauthCase(
                  tokenUpdate(`confirmation = '{"jkt":"synthetic-thumbprint"}'::jsonb`),
                ).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "scope without mcp",
                oauthCase(tokenUpdate(`scopes = '["offline_access"]'::jsonb`)).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "audience names no stored resource",
                oauthCase(
                  tokenUpdate(
                    `resources = $2::jsonb`,
                    JSON.stringify([`${origin}/mcp?connection=missing`]),
                  ),
                ).pipe(Effect.orDie),
                unauthorized,
              ],
            ];
            for (const [name, create, expected] of cases) {
              const { token, path } = yield* create;
              yield* expectStatus(name, yield* status(path, token), expected);
            }
          }),
        );

        yield* evidence.step(
          "OAuth tokens are refused when their grant, consent or membership no longer allows them",
          Effect.gen(function* () {
            const cases: ReadonlyArray<
              readonly [
                string,
                Effect.Effect<{ token: string; path: string }>,
                ReadonlyArray<number>,
                string?,
              ]
            > = [
              [
                "grant revoked",
                oauthCase(grantUpdate(`revoked = true`)).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "grant held by another user",
                oauthCase(grantUpdate(`"userId" = $2`, memberId)).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "grant held by another client",
                oauthCase(grantUpdate(`"clientId" = 'synthetic-other-client'`)).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "consent for the API audience",
                oauthCase(
                  consentUpdate(`resources = $2::jsonb`, JSON.stringify([`${origin}/api`])),
                ).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "consent for another MCP approval mode",
                oauthCase(
                  consentUpdate(
                    `resources = $2::jsonb`,
                    JSON.stringify([`${origin}/mcp?elicitation_mode=browser`]),
                  ),
                ).pipe(Effect.orDie),
                unauthorized,
              ],
              [
                "grant in an organization without membership",
                oauthCase(grantUpdate(`resource = $2`, notMember)).pipe(Effect.orDie),
                forbidden,
              ],
              [
                "grant in an organization with an unknown role",
                oauthCase(grantUpdate(`resource = $2`, unknownRole)).pipe(Effect.orDie),
                forbidden,
              ],
              [
                "MCP grant on the Executor API",
                oauthCase(() => []).pipe(Effect.orDie),
                unauthorized,
                "/api/context",
              ],
            ];
            for (const [name, create, expected, path] of cases) {
              const created = yield* create;
              yield* expectStatus(
                name,
                yield* status(path ?? created.path, created.token),
                expected,
              );
            }
            const named = yield* oauthCase(() => []).pipe(Effect.orDie);
            yield* expectStatus(
              "header names the grant's organization",
              yield* status(named.path, named.token, { "x-executor-organization": organization }),
              accepted,
            );
            yield* expectStatus(
              "header names another organization",
              yield* status(named.path, named.token, { "x-executor-organization": notMember }),
              forbidden,
            );
            yield* expectStatus(
              "URL reference matches two organizations",
              yield* status(`/org/${ambiguous}/mcp`, named.token),
              forbidden,
            );
          }),
        );

        yield* evidence.step(
          "Connection grants read their connection on every use",
          Effect.gen(function* () {
            const connection = (set: string, ...params: Param[]) =>
              oauthCase(
                (ids) =>
                  set === ""
                    ? []
                    : [
                        {
                          sql: `update "mcpConnection" set ${set} where id = $1`,
                          params: [ids.connection, ...params],
                        },
                      ],
                { connection: true },
              ).pipe(Effect.orDie);
            const cases: ReadonlyArray<
              readonly [
                string,
                Effect.Effect<{ token: string; path: string }>,
                ReadonlyArray<number>,
              ]
            > = [
              ["live connection", connection(""), accepted],
              ["connection revoked", connection(`revoked = true`), unauthorized],
              [
                "connection held by another user",
                connection(`"userId" = $2`, memberId),
                unauthorized,
              ],
              [
                "connection in another organization",
                connection(`resource = $2`, notMember),
                unauthorized,
              ],
              ["connection policy unreadable", connection(`policy = '{"apps":"none"}'`), [503]],
            ];
            for (const [name, create, expected] of cases) {
              const { token, path } = yield* create;
              yield* expectStatus(name, yield* status(path, token), expected);
            }
          }),
        );

        yield* evidence.step(
          "A resource's custom grant_id claim selects the grant Better Auth checks",
          Effect.gen(function* () {
            const claims = (value: (ids: { readonly grant: string }) => unknown) =>
              oauthCase(
                (ids) => [
                  {
                    sql: `update "oauthResource" set "customClaims" = $2::jsonb where identifier =
                      (select resources ->> 0 from "oauthAccessToken" where token = $1)`,
                    params: [ids.token, JSON.stringify(value(ids))],
                  },
                ],
                { connection: true },
              ).pipe(Effect.orDie);
            const revoked = yield* oauthCase(grantUpdate(`revoked = true`)).pipe(Effect.orDie);
            const revokedRow = (yield* rows([
              {
                sql: `select "referenceId" as id from "oauthAccessToken" where token = $1`,
                params: [hashed(revoked.token)],
              },
            ]))[0]?.[0];
            const revokedGrant = (yield* Schema.decodeUnknownEffect(
              Schema.Struct({ id: Schema.String }),
            )(revokedRow)).id;
            const cases: ReadonlyArray<
              readonly [
                string,
                Effect.Effect<{ token: string; path: string }>,
                ReadonlyArray<number>,
              ]
            > = [
              ["claims without grant_id", claims(() => ({ tenant: "synthetic" })), accepted],
              [
                "grant_id names the token's grant",
                claims((ids) => ({ grant_id: ids.grant })),
                accepted,
              ],
              [
                "grant_id names a missing grant",
                claims(() => ({ grant_id: "grant-missing" })),
                unauthorized,
              ],
              [
                "grant_id names a revoked grant",
                claims(() => ({ grant_id: revokedGrant })),
                unauthorized,
              ],
              ["grant_id is null", claims(() => ({ grant_id: null })), unauthorized],
            ];
            for (const [name, create, expected] of cases) {
              const { token, path } = yield* create;
              yield* expectStatus(name, yield* status(path, token), expected);
            }
          }),
        );

        yield* evidence.step(
          "Stored JSON fields decode as Better Auth decodes them",
          Effect.gen(function* () {
            // A `jsonb` string holding JSON reads as its contents: the driver decodes the
            // `jsonb`, and Better Auth's adapter parses a string `string[]` field again.
            const twice = (value: unknown) => JSON.stringify(JSON.stringify(value));
            const cases: ReadonlyArray<
              readonly [
                string,
                Effect.Effect<{ token: string; path: string }>,
                ReadonlyArray<number>,
              ]
            > = [
              [
                "scopes stored as a JSON string",
                oauthCase(tokenUpdate(`scopes = $2::jsonb`, twice(["mcp", "offline_access"]))).pipe(
                  Effect.orDie,
                ),
                accepted,
              ],
              [
                "audience stored as a JSON string",
                oauthCase(tokenUpdate(`resources = $2::jsonb`, twice([`${origin}/mcp`]))).pipe(
                  Effect.orDie,
                ),
                accepted,
              ],
              [
                "consent stored as a JSON string",
                oauthCase(consentUpdate(`resources = $2::jsonb`, twice([`${origin}/mcp`]))).pipe(
                  Effect.orDie,
                ),
                accepted,
              ],
              [
                "scopes encoded three times",
                oauthCase(
                  tokenUpdate(
                    `scopes = $2::jsonb`,
                    JSON.stringify(twice(["mcp", "offline_access"])),
                  ),
                ).pipe(Effect.orDie),
                [401, 503],
              ],
              [
                "consent encoded three times",
                oauthCase(
                  consentUpdate(`resources = $2::jsonb`, JSON.stringify(twice([`${origin}/mcp`]))),
                ).pipe(Effect.orDie),
                unauthorized,
              ],
            ];
            for (const [name, create, expected] of cases) {
              const { token, path } = yield* create;
              yield* expectStatus(name, yield* status(path, token), expected);
            }
          }),
        );

        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Bearer refusals",
        });
        expect(created.status).toBe(200);
        const key = yield* body(Token, created);
        owned.keys.push(key.id);
        /** A copy of the PAT with its own secret, then the case's change to that copy. */
        const patCase = (set: string, ...params: Param[]) =>
          Effect.gen(function* () {
            const secret = unique("exp_"),
              id = unique("key-");
            owned.keys.push(id);
            yield* rows([
              copy("apikey", "r.id = $2", { id, key: hashed(secret) }, [key.id]),
              ...(set === ""
                ? []
                : [{ sql: `update apikey set ${set} where id = $1`, params: [id, ...params] }]),
            ]);
            return { secret, id };
          }).pipe(Effect.orDie);
        const expiredKeys = yield* evidence.step(
          "PATs are refused when Better Auth's key check or the organization rules refuse them",
          Effect.gen(function* () {
            const api = (secret: string, named: string | null = organization) =>
              status(
                "/api/context",
                secret,
                named === null ? {} : { "x-executor-organization": named },
              );
            const mcp = (secret: string, named: string = organization) =>
              status(`/org/${named}/mcp`, secret);
            const live = yield* patCase("");
            yield* expectStatus("PAT copy on the API", yield* api(live.secret), accepted);
            yield* expectStatus("PAT copy on MCP", yield* mcp(live.secret), accepted);
            yield* expectStatus(
              "PAT without an organization",
              yield* api(live.secret, null),
              forbidden,
            );
            yield* expectStatus(
              "PAT for a non-member organization",
              yield* api(live.secret, notMember),
              forbidden,
            );
            yield* expectStatus(
              "PAT for an unknown role",
              yield* mcp(live.secret, unknownRole),
              forbidden,
            );
            yield* expectStatus(
              "PAT for an ambiguous reference",
              yield* api(live.secret, ambiguous),
              forbidden,
            );
            const future = yield* patCase(`"expiresAt" = now() + interval '1 hour'`);
            yield* expectStatus("PAT expiring in an hour", yield* mcp(future.secret), accepted);
            const disabled = yield* patCase(`enabled = false`);
            yield* expectStatus("disabled PAT", yield* api(disabled.secret), unauthorized);
            const pinned = yield* patCase(
              `metadata = $2`,
              JSON.stringify({ organization: unknownRole }),
            );
            yield* expectStatus(
              "PAT pinned to another organization",
              yield* api(pinned.secret),
              forbidden,
            );
            const legacyPinned = yield* patCase(
              `metadata = $2`,
              JSON.stringify(JSON.stringify({ organization: unknownRole })),
            );
            yield* expectStatus(
              "PAT with twice-encoded pinned metadata",
              yield* mcp(legacyPinned.secret),
              forbidden,
            );
            const expired = yield* patCase(`"expiresAt" = now() - interval '1 second'`);
            yield* expectStatus(
              "PAT expired one second ago",
              yield* api(expired.secret),
              unauthorized,
            );
            const [stored] = yield* rows([
              {
                sql: `select count(*)::int as keys from apikey where id = $1`,
                params: [expired.id],
              },
            ]);
            return stored;
          }),
        );
        yield* evidence.json("bearer-refusals.json", { outcomes, expiredKeys });
        expect(
          outcomes.filter(({ status, expected }) => !expected.includes(status)),
          "every case is accepted or refused as Better Auth decides",
        ).toEqual([]);
        // Better Auth deletes an enabled key that is presented after its expiry.
        expect(expiredKeys, "an expired PAT is deleted on use").toEqual([{ keys: 0 }]);
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
});
