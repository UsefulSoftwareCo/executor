import { Clock, Effect, Option, Redacted, Schema } from "effect";
import {
  isFirstPartyAttempt,
  isFirstPartyGrant,
  OAuthAttemptId,
  OAuthAttemptRecord,
  OAuthClientId,
  OAuthGrant,
} from "../contracts/oauth.ts";
import type {
  OwnerMove,
  OwnerMoveBlocked,
  OwnerMoveCollision,
  OwnerMoves,
} from "../contracts/owner.ts";
import {
  AccountConnectionId,
  AccountId,
  ApprovalRequestId,
  JsonObject,
  OwnerId,
  type ProviderId,
  StorageError,
} from "../contracts/shared.ts";
import { type Credentials, StoredConnectionTarget } from "../contracts/storage.ts";
import { StoredState } from "./connection-state.ts";
import { query, transaction } from "./database.ts";
import type { Query } from "./database.ts";
import { StoredClientSecret, storedRegistration } from "./oauth.ts";
import {
  credentialsDigest,
  legacyCredentialsDigest,
  oauthClientIssuer,
} from "./stored-oauth-client-credentials.ts";
import { ApprovalPayload } from "./tool-approvals.ts";

type ClientCopy = Pick<
  StoredClientSecret,
  "client_id" | "client_secret" | "token_endpoint_auth_method"
>;
interface CopySource {
  readonly owner: OwnerId;
  readonly issuer: string | null;
  readonly provider: ProviderId | null;
  readonly copy: ClientCopy;
}
const Owned = Schema.Struct({ owner: OwnerId });
const isObject = Schema.is(JsonObject);
const decodeObject = Schema.decodeUnknownEffect(JsonObject);

const ownerTables = [
  "apps",
  "accounts",
  "deployments",
  "profiles",
  "schedules",
  "scheduledRuns",
  "workflowRuns",
  "workflowInputs",
  "webhooks",
  "webhookSources",
  "eventSubscriptions",
  "accountConnections",
  "toolApprovals",
  "storedOAuthClients",
] as const;

export const makeOwnerMoves = (db: Query, credentials: Credentials): OwnerMoves => {
  const decrypt = (identity: Parameters<Credentials["decrypt"]>[0], bytes: Uint8Array) =>
    credentials.decrypt(identity, Redacted.make(bytes)).pipe(Effect.map(Redacted.value));
  const encrypt = (identity: Parameters<Credentials["encrypt"]>[0], value: JsonObject) =>
    credentials
      .encrypt(identity, Redacted.make(value))
      .pipe(Effect.mapError(() => new StorageError()));
  const digestsOf = (owner: OwnerId, source: CopySource) => {
    const client = {
      owner,
      clientId: source.copy.client_id,
      secret:
        source.copy.token_endpoint_auth_method === "none" ? undefined : source.copy.client_secret,
    };
    return Effect.all([
      source.issuer === null
        ? Effect.succeed(undefined)
        : credentialsDigest(credentials, { ...client, issuer: source.issuer }),
      source.provider === null
        ? Effect.succeed(undefined)
        : legacyCredentialsDigest(credentials, { ...client, provider: source.provider }),
    ]).pipe(
      Effect.map((digests) => digests.filter((digest) => digest !== undefined)),
      Effect.mapError(() => new StorageError()),
    );
  };

  const owners = Effect.all(
    [
      query(() => db.findMany("apps", { select: ["owner"] })),
      query(() => db.findMany("accounts", { select: ["owner"] })),
      query(() => db.findMany("deployments", { select: ["owner"] })),
      query(() => db.findMany("profiles", { select: ["owner"] })),
      query(() => db.findMany("schedules", { select: ["owner"] })),
      query(() => db.findMany("scheduledRuns", { select: ["owner"] })),
      query(() => db.findMany("workflowRuns", { select: ["owner"] })),
      query(() => db.findMany("webhooks", { select: ["owner"] })),
      query(() => db.findMany("webhookSources", { select: ["owner"] })),
      query(() => db.findMany("eventSubscriptions", { select: ["owner"] })),
      query(() => db.findMany("accountConnections", { select: ["owner"] })),
      query(() => db.findMany("toolApprovals", { select: ["owner"] })),
      query(() => db.findMany("storedOAuthClients", { select: ["owner"] })),
      query(() => db.findMany("storedOAuthClientCredentials", { select: ["owner"] })),
      query(() => db.findMany("toolSearchListings", { select: ["owner"] })),
    ],
    { concurrency: 1 },
  ).pipe(
    Effect.map((tables) => [...new Set(tables.flat().map((row) => row.owner))].toSorted()),
    Effect.withSpan("sdk.owners.list"),
  );

  const move: OwnerMoves["move"] = (input) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const to = input.to;
        const from = [...new Set(input.from)].filter((owner) => owner !== to);
        const moving = (owner: OwnerId) => from.includes(owner);
        const moved = (value: unknown) => {
          if (!isObject(value)) return undefined;
          const owned = Schema.decodeUnknownOption(Owned)(value);
          return Option.isSome(owned) && moving(owned.value.owner)
            ? { ...value, owner: to }
            : undefined;
        };
        const collisions: OwnerMoveCollision[] = [];
        const blocked: OwnerMoveBlocked[] = [];
        const readable = <A, E>(record: OwnerMoveBlocked, read: Effect.Effect<A, E>) =>
          read.pipe(
            Effect.option,
            Effect.tap((result) =>
              Effect.sync(() => {
                if (Option.isNone(result)) blocked.push(record);
              }),
            ),
          );
        const now = new Date(yield* Clock.currentTimeMillis);

        const apps = yield* query(() =>
          tx.findMany("apps", {
            select: ["id", "owner", "name", "slug"],
            where: (b) => b("owner", "in", [...from, to]),
            orderBy: ["id", "asc"],
          }),
        );
        for (const [kind, field] of [
          ["app_name", "name"],
          ["app_slug", "slug"],
        ] as const)
          for (const [key, group] of groupBy(apps, (app) => app[field]))
            if (group.length > 1)
              collisions.push({
                kind,
                key,
                records: group.map((app) => ({ owner: app.owner, id: app.id })),
              });

        const copies: Array<CopySource> = [];
        for (const client of yield* query(() =>
          tx.findMany("storedOAuthClients", { where: (b) => b("owner", "in", from) }),
        )) {
          const copy = yield* readable(
            { kind: "oauth_client", id: client.id, owner: client.owner },
            decrypt(OAuthClientId.make(client.id), client.encrypted).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(StoredClientSecret)),
              Effect.tap(storedRegistration),
            ),
          );
          if (Option.isSome(copy))
            copies.push({
              owner: client.owner,
              issuer: client.issuer,
              provider: client.provider,
              copy: copy.value,
            });
        }
        const accounts = yield* query(() =>
          tx.findMany("accounts", {
            select: ["id", "owner", "provider"],
            where: (b) => b("owner", "in", from),
          }),
        );
        const grants =
          accounts.length === 0
            ? []
            : yield* query(() =>
                tx.findMany("oauthGrants", {
                  where: (b) =>
                    b(
                      "id",
                      "in",
                      accounts.map((account) => account.id),
                    ),
                }),
              );
        for (const row of grants) {
          const account = accounts.find((each) => each.id === AccountId.make(row.id));
          if (account === undefined) continue;
          const grant = yield* readable(
            { kind: "oauth_grant", id: account.id, owner: account.owner },
            decrypt(account.id, row.encrypted).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(OAuthGrant)),
            ),
          );
          if (Option.isSome(grant) && !isFirstPartyGrant(grant.value))
            copies.push({
              owner: account.owner,
              issuer: oauthClientIssuer(grant.value.server),
              provider: account.provider,
              copy: grant.value.client,
            });
        }
        const attempts: Array<{ id: OAuthAttemptId; record: JsonObject }> = [];
        for (const row of yield* query(() =>
          tx.findMany("oauthAttempts", {
            select: ["id", "encrypted"],
            where: (b) => b.and(b("status", "=", "pending"), b("expiresAt", ">", now)),
          }),
        )) {
          const id = OAuthAttemptId.make(row.id);
          const read = yield* readable(
            { kind: "oauth_sign_in", id },
            decrypt(id, row.encrypted).pipe(
              Effect.flatMap((record) =>
                Schema.decodeUnknownEffect(OAuthAttemptRecord)(record).pipe(
                  Effect.map((attempt) => ({ record, attempt })),
                ),
              ),
            ),
          );
          if (Option.isNone(read) || !moving(read.value.attempt.owner)) continue;
          const { record, attempt } = read.value;
          attempts.push({ id, record: { ...record, owner: to } });
          if (!isFirstPartyAttempt(attempt))
            copies.push({
              owner: attempt.owner,
              issuer: oauthClientIssuer(attempt.server),
              provider: attempt.provider,
              copy: attempt.client,
            });
        }
        const rekeyed = new Map<string, string>();
        for (const source of copies) {
          const before = yield* digestsOf(source.owner, source);
          const after = yield* digestsOf(to, source);
          before.forEach((digest, index) => {
            const next = after[index];
            if (!rekeyed.has(digest) && next !== undefined) rekeyed.set(digest, next);
          });
        }
        const held = yield* query(() =>
          tx.findMany("storedOAuthClientCredentials", {
            where: (b) => b("owner", "in", [...from, to]),
            orderBy: ["id", "asc"],
          }),
        );
        const identity = (row: (typeof held)[number]) =>
          moving(row.owner) ? (rekeyed.get(row.id) ?? row.id) : row.id;
        for (const group of groupBy(held, identity).values())
          if (group.length > 1) {
            const clients = yield* query(() =>
              tx.findMany("storedOAuthClients", {
                select: ["provider", "issuer", "clientId"],
                where: (b) =>
                  b(
                    "id",
                    "in",
                    group.map((row) => row.client),
                  ),
              }),
            );
            const [first] = clients;
            collisions.push({
              kind: "oauth_client_credentials",
              key:
                first === undefined
                  ? (group[0]?.provider ?? "")
                  : `${first.issuer ?? first.provider ?? ""} ${first.clientId}`,
              records: group.map((row) => ({ owner: row.owner, id: row.client })),
            });
          }

        const connections: Array<{
          id: AccountConnectionId;
          target: JsonObject;
          state: JsonObject;
        }> = [];
        for (const row of yield* query(() =>
          tx.findMany("accountConnections", { select: ["id", "owner", "target", "state"] }),
        )) {
          const read = yield* readable(
            { kind: "account_connection", id: row.id, owner: row.owner },
            Effect.all([
              Schema.decodeUnknownEffect(StoredConnectionTarget)(row.target),
              Schema.decodeUnknownEffect(StoredState)(row.state),
            ]).pipe(
              Effect.andThen(Effect.all([decodeObject(row.target), decodeObject(row.state)])),
            ),
          );
          if (Option.isNone(read)) continue;
          const [target, state] = read.value;
          const movedTarget = moved(target);
          const account = moved(state["account"]);
          if (movedTarget !== undefined || account !== undefined)
            connections.push({
              id: row.id,
              target: movedTarget ?? target,
              state: account === undefined ? state : { ...state, account },
            });
        }
        const approvals: Array<{ id: ApprovalRequestId; record: JsonObject }> = [];
        for (const row of yield* query(() =>
          tx.findMany("toolApprovals", {
            select: ["id", "owner", "encrypted"],
            where: (b) => b.and(b("status", "=", "pending"), b("expiresAt", ">", now)),
          }),
        )) {
          const id = ApprovalRequestId.make(row.id);
          const read = yield* readable(
            { kind: "tool_approval", id, owner: row.owner },
            decrypt(id, row.encrypted).pipe(
              Effect.flatMap((record) =>
                Schema.decodeUnknownEffect(ApprovalPayload)(record).pipe(Effect.as(record)),
              ),
            ),
          );
          if (Option.isNone(read)) continue;
          const record = read.value;
          const invocation = record["invocation"];
          if (!isObject(invocation) || !isObject(invocation["accounts"])) continue;
          let changed = moved(invocation) !== undefined;
          const accounts = Object.fromEntries(
            Object.entries(invocation["accounts"]).map(([scope, slots]) => [
              scope,
              isObject(slots)
                ? Object.fromEntries(
                    Object.entries(slots).map(([slot, selected]) => {
                      const each = Array.isArray(selected) ? selected : [selected];
                      const next = each.map((account) => moved(account) ?? account);
                      if (next.some((account, index) => account !== each[index])) changed = true;
                      return [slot, Array.isArray(selected) ? next : (next[0] ?? selected)];
                    }),
                  )
                : slots,
            ]),
          );
          if (changed)
            approvals.push({
              id,
              record: { ...record, invocation: { ...(moved(invocation) ?? invocation), accounts } },
            });
        }
        if (blocked.length > 0)
          return { status: "blocked", collisions, blocked, rows: {} } satisfies OwnerMove;
        if (collisions.length > 0)
          return { status: "collision", collisions, blocked, rows: {} } satisfies OwnerMove;
        const listings = yield* query(() =>
          tx.findMany("toolSearchListings", {
            select: ["listing"],
            where: (b) => b("owner", "in", from),
          }),
        );

        const rows: Record<string, number> = {};
        for (const table of ownerTables)
          rows[table] = (yield* query(() =>
            tx.findMany(table, { select: ["owner"], where: (b) => b("owner", "in", from) }),
          )).length;
        const movedCredentials = held.filter((row) => moving(row.owner));
        rows["storedOAuthClientCredentials"] = movedCredentials.length;
        rows["storedOAuthClientCredentials.rekeyed"] = movedCredentials.filter((row) =>
          rekeyed.has(row.id),
        ).length;
        rows["accountConnections.recorded"] = connections.length;
        rows["oauthAttempts"] = attempts.length;
        rows["toolApprovals.invocation"] = approvals.length;
        rows["toolSearchListings.removed"] = listings.length;
        if (!input.apply)
          return { status: "would_move", collisions, blocked, rows } satisfies OwnerMove;

        for (const table of ownerTables)
          yield* query(() =>
            tx.updateMany(table, { where: (b) => b("owner", "in", from), set: { owner: to } }),
          );
        for (const row of movedCredentials) {
          const id = identity(row);
          if (id !== row.id)
            yield* query(() =>
              tx.deleteMany("storedOAuthClientCredentials", { where: (b) => b("id", "=", row.id) }),
            );
          yield* id === row.id
            ? query(() =>
                tx.updateMany("storedOAuthClientCredentials", {
                  where: (b) => b("id", "=", row.id),
                  set: { owner: to },
                }),
              )
            : query(() => tx.create("storedOAuthClientCredentials", { ...row, id, owner: to }));
        }
        for (const connection of connections)
          yield* query(() =>
            tx.updateMany("accountConnections", {
              where: (b) => b("id", "=", connection.id),
              set: { target: connection.target, state: connection.state },
            }),
          );
        for (const attempt of attempts) {
          const encrypted = yield* encrypt(attempt.id, attempt.record);
          yield* query(() =>
            tx.updateMany("oauthAttempts", {
              where: (b) => b("id", "=", attempt.id),
              set: { encrypted },
            }),
          );
        }
        for (const approval of approvals) {
          const encrypted = yield* encrypt(approval.id, approval.record);
          yield* query(() =>
            tx.updateMany("toolApprovals", {
              where: (b) => b("id", "=", approval.id),
              set: { encrypted },
            }),
          );
        }
        if (listings.length > 0) {
          const ids = listings.map((row) => row.listing);
          yield* query(() =>
            tx.deleteMany("toolSearch", { where: (b) => b("listing", "in", ids) }),
          );
          yield* query(() =>
            tx.deleteMany("toolSearchDefinitions", { where: (b) => b("listing", "in", ids) }),
          );
          yield* query(() =>
            tx.deleteMany("toolSearchListings", { where: (b) => b("listing", "in", ids) }),
          );
        }
        return { status: "moved", collisions, blocked, rows } satisfies OwnerMove;
      }),
    ).pipe(Effect.withSpan("sdk.owners.move"));

  return { owners, move };
};

const groupBy = <A, K>(values: ReadonlyArray<A>, key: (value: A) => K) => {
  const groups = new Map<K, A[]>();
  for (const value of values) {
    const group = groups.get(key(value));
    if (group === undefined) groups.set(key(value), [value]);
    else group.push(value);
  }
  return groups;
};
