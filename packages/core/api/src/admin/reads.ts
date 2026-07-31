// ---------------------------------------------------------------------------
// The READ half of the admin users surface, shared by every host.
//
// A host's `AdminUsersProvider` owns AUTHORIZATION (who may look) and delegates
// the actual reads here, so the projection from the SDK's platform view onto
// the wire shapes exists exactly ONCE. That matters because the projection IS
// the field-discipline boundary: if each host mapped rows itself, a credential
// field could leak into one host's responses and not the other's.
//
// Every mapping below is explicit rather than a spread. A spread would silently
// forward any field a future SDK change adds to `AdminSubject`/`AdminConnection`
// — the opposite of an allowlist.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type {
  AdminConnection,
  AdminSubject,
  AdminSubjectWithConnections,
  Executor,
  ExecutorAdmin,
} from "@executor-js/sdk";

import {
  AdminUserNotFound,
  AdminUsersError,
  type AdminUserConnectionsResponse,
  type AdminUserResponse,
  type AdminUsersResponse,
  type AdminUsersWithConnectionsResponse,
} from "./api";
import type { AdminUsersListOptions } from "./service";

/**
 * Narrow an executor to its platform view. `admin` is present only when the
 * executor was built with `platformView: true`; a host that reaches these reads
 * with a product-view executor is a wiring bug, so it fails loudly as a 500
 * rather than silently returning an empty tenant (which would read as "this
 * owner has no users").
 */
export const platformViewOf = (executor: Executor): Effect.Effect<ExecutorAdmin, AdminUsersError> =>
  executor.admin
    ? Effect.succeed(executor.admin)
    : Effect.fail(
        new AdminUsersError({
          message: "Admin reads require an executor built with the platform view enabled",
        }),
      );

// Storage faults are the only failure these reads can raise. They surface as a
// 500 with a flat message — the cause carries the detail into the host's error
// capture, and is deliberately not echoed to an API consumer.
const readFailed = (what: string) => () =>
  new AdminUsersError({ message: `Failed to list ${what}` });

// ---------------------------------------------------------------------------
// Host identity join
// ---------------------------------------------------------------------------

/** What a host's member directory can say about one principal. Both halves are
 *  independently nullable: a directory can hold an email with no name. */
export interface AdminUserIdentity {
  readonly email: string | null;
  readonly displayName: string | null;
}

/**
 * The ONE email normalization rule: shared by the `?email=` filter, the
 * single-user path parameter, and every host's own resolver (which must apply
 * it to the DIRECTORY value before comparing).
 *
 * Case-insensitive because the two hosts disagree about what they store:
 * Better Auth lower-cases every email it writes, while WorkOS preserves the
 * casing it was given. Lower-casing BOTH sides is the only rule that answers
 * the same way on both. The local part of an address is technically
 * case-sensitive per RFC 5321, but no directory this reads treats it that way,
 * and an operator typing "Alice@..." means the same person.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * A host's member directory, keyed by the SAME id space the subject table
 * records in `external_id`.
 *
 * That id is the host-auth principal id — cloud binds the WorkOS `user_...`,
 * self-host binds the Better Auth `user.id` — so the join key on both hosts is
 * the member list's `userId`, NEVER its `id` (a membership-row id: `om_...` on
 * cloud, the `member` row on self-host, both of which join to nothing).
 *
 * Called ONCE per request with the whole page of ids, so a host implements it
 * as one directory read joined in memory rather than a lookup per user. A host
 * that cannot resolve identities at all simply passes no directory, and every
 * row reports absent identity.
 */
export type AdminIdentityDirectory = (
  externalIds: readonly string[],
) => Effect.Effect<ReadonlyMap<string, AdminUserIdentity>, unknown>;

/**
 * The REVERSE of the join above: email → the host-auth principal id, so an
 * operator can name a user by the identifier they actually have.
 *
 * The email arrives already trimmed and lower-cased by the contract, and an
 * implementation must compare against a lower-cased directory value — neither
 * host guarantees the casing it stores, so case-insensitivity is the seam's
 * rule and not a per-host accident.
 *
 * `null` means the directory knows no such member. That is NOT the same as
 * "not a user of this tenant": a resolved id may still have no subject row,
 * which the reads below treat as absent (see `getUser`). Failures are the
 * caller's to interpret — unlike the decorative identity join, a lookup that
 * cannot run must not silently become "no such user".
 */
export type AdminEmailResolver = (email: string) => Effect.Effect<string | null, unknown>;

/** Both directions of a host's member directory. Optional as a whole (a host
 *  with no directory reports unnamed rows and cannot resolve emails), and
 *  optional per direction. */
export interface AdminUserDirectory {
  readonly identities?: AdminIdentityDirectory;
  readonly resolveEmail?: AdminEmailResolver;
}

/** Identity is decoration on an operator view, not part of the answer: a
 *  directory outage must degrade to unnamed rows, never fail the read the
 *  operator actually asked for. Logged once per failed page — the cause carries
 *  the detail, and the caller learns nothing from it. */
const resolveIdentities = (
  directory: AdminIdentityDirectory | undefined,
  externalIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, AdminUserIdentity>> => {
  if (!directory || externalIds.length === 0) return Effect.succeed(new Map());
  return directory(externalIds).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("admin users: host identity lookup failed; reporting users unnamed", {
          cause,
        }),
        new Map<string, AdminUserIdentity>(),
      ),
    ),
  );
};

const ABSENT_IDENTITY: AdminUserIdentity = { email: null, displayName: null };

/**
 * `AdminSubject` → the public `AdminUser` shape.
 *
 * `createdAt` crosses the wire as epoch ms (the SDK hands back a `Date`), which
 * matches how every other "when did this happen" field on the API is carried
 * and keeps the whole response JSON-native.
 *
 * `email`/`displayName` come from the host directory rather than storage, so an
 * id the directory doesn't know — a member who left the org while their
 * connections remain, or a host sentinel like "local" that names no member —
 * reports absent identity beside otherwise complete row data.
 */
const toUser = (subject: AdminSubject, identities: ReadonlyMap<string, AdminUserIdentity>) => {
  const identity = identities.get(subject.externalId) ?? ABSENT_IDENTITY;
  return {
    externalId: subject.externalId,
    createdAt: subject.createdAt.getTime(),
    lastSeenAt: subject.lastSeenAt,
    status: subject.status,
    email: identity.email,
    displayName: identity.displayName,
  };
};

/**
 * The stored health verdict → the admin plane's `AdminConnectionHealth`.
 *
 * NESTED OBJECTS GET THE SAME TREATMENT AS COLUMNS. `HealthCheckResult` is the
 * owner's view of their own probe and carries content taken from the UPSTREAM
 * provider's response: `identity` (the value at the configured `identityField`
 * — usually the account's email at the provider), `detail` (a raw diagnostic
 * that can quote an upstream error body), and `responseSample` (a bounded
 * sample of the real response body's scalar leaves). This plane reports on
 * OTHER people's connections, so none of that may travel; forwarding
 * `connection.lastHealth` whole is exactly the leak this function exists to
 * prevent — the column allowlist below would still have "passed" while every
 * upstream field rode along inside it.
 *
 * Two fields survive, both of them verdicts ABOUT the connection rather than
 * content FROM it: `status` and `checkedAt`. Written as an explicit
 * construction, never a spread, for the same reason the row mappings are.
 */
const toHealth = (health: AdminConnection["lastHealth"]) =>
  health === null ? null : { status: health.status, checkedAt: health.checkedAt };

/**
 * `AdminConnection` → the public `AdminUserConnection` shape.
 *
 * `subject` is dropped: on `/admin/users/:externalId/connections` it is the
 * path parameter, and on the joined view it is the enclosing user's own id, so
 * carrying it would be redundant on both. Everything kept here is either an
 * identifier or a health/access summary — never credential material, and never
 * upstream account content (see `toHealth`).
 */
const toConnection = (connection: AdminConnection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
  oauthScope: connection.oauthScope,
  lastHealth: toHealth(connection.lastHealth),
});

const toUserWithConnections = (
  subject: AdminSubjectWithConnections,
  identities: ReadonlyMap<string, AdminUserIdentity>,
) => ({
  ...toUser(subject, identities),
  connections: subject.connections.map(toConnection),
});

/**
 * Accept the legacy one-way directory or the two-way one, so a host that only
 * joins identities keeps working unchanged.
 */
const asDirectory = (
  directory: AdminIdentityDirectory | AdminUserDirectory | undefined,
): AdminUserDirectory =>
  directory === undefined
    ? {}
    : typeof directory === "function"
      ? { identities: directory }
      : directory;

/**
 * Turn an `?email=` filter into the id to keep, or `null` for "nothing can
 * match" (unknown email, or a host with no resolver — an email filter no host
 * can answer must return nothing, never an unfiltered page).
 *
 * A resolver FAILURE is a 500, not an empty page: silently reporting "no such
 * user" because a directory was unreachable is the kind of wrong answer an
 * operator would act on.
 */
const resolveEmailFilter = (
  directory: AdminUserDirectory,
  email: string,
): Effect.Effect<string | null, AdminUsersError> => {
  const resolve = directory.resolveEmail;
  if (!resolve) return Effect.succeed(null);
  return resolve(email).pipe(
    Effect.mapError(() => new AdminUsersError({ message: "Failed to resolve the email address" })),
  );
};

/** Keep only the subject naming `externalId`. The filter is applied AFTER the
 *  page read, so it narrows the requested page rather than scanning past it —
 *  see the contract's note on paging a filtered result. */
const filterToId = <T extends { readonly externalId: string }>(
  subjects: readonly T[],
  externalId: string | null,
): readonly T[] =>
  externalId === null ? [] : subjects.filter((subject) => subject.externalId === externalId);

export const listUsers = (
  admin: ExecutorAdmin,
  options: AdminUsersListOptions,
  directory?: AdminIdentityDirectory | AdminUserDirectory,
): Effect.Effect<typeof AdminUsersResponse.Type, AdminUsersError> =>
  Effect.gen(function* () {
    const dir = asDirectory(directory);
    const wanted =
      options.email === undefined ? undefined : yield* resolveEmailFilter(dir, options.email);
    const all = yield* admin.listSubjects(options).pipe(Effect.mapError(readFailed("users")));
    const subjects = wanted === undefined ? all : filterToId(all, wanted);
    // One directory read for the page that was actually returned, joined in
    // memory — never a lookup per user.
    const identities = yield* resolveIdentities(
      dir.identities,
      subjects.map((subject) => subject.externalId),
    );
    return { users: subjects.map((subject) => toUser(subject, identities)) };
  });

export const listUsersWithConnections = (
  admin: ExecutorAdmin,
  options: AdminUsersListOptions,
  directory?: AdminIdentityDirectory | AdminUserDirectory,
): Effect.Effect<typeof AdminUsersWithConnectionsResponse.Type, AdminUsersError> =>
  Effect.gen(function* () {
    const dir = asDirectory(directory);
    const wanted =
      options.email === undefined ? undefined : yield* resolveEmailFilter(dir, options.email);
    const all = yield* admin
      .listSubjectsWithConnections(options)
      .pipe(Effect.mapError(readFailed("users")));
    const subjects = wanted === undefined ? all : filterToId(all, wanted);
    const identities = yield* resolveIdentities(
      dir.identities,
      subjects.map((subject) => subject.externalId),
    );
    return { users: subjects.map((subject) => toUserWithConnections(subject, identities)) };
  });

/**
 * One user by `externalId` OR email, with connections.
 *
 * RESOLUTION ORDER. An identifier containing "@" is tried as an email first;
 * if the directory knows no such member, or the id it resolves to has no
 * subject row, the identifier is then tried as a literal `externalId`. That
 * fallback is what keeps `externalId` opaque: no host mints an id containing
 * "@" today, but the contract promises nothing may parse the id, so the "@"
 * test is only ever a routing hint that costs one extra keyed read in a case
 * that does not currently arise.
 *
 * A directory hit with no subject row is `AdminUserNotFound`, the same as an
 * unknown identifier — the plane reports footprint, not org membership. See
 * the `getUser` contract docs for why.
 */
export const getUser = (
  admin: ExecutorAdmin,
  identifier: string,
  directory?: AdminIdentityDirectory | AdminUserDirectory,
): Effect.Effect<typeof AdminUserResponse.Type, AdminUsersError | AdminUserNotFound> =>
  Effect.gen(function* () {
    const dir = asDirectory(directory);
    const read = (externalId: string) =>
      admin.getSubjectWithConnections(externalId).pipe(Effect.mapError(readFailed("user")));

    const subject = yield* identifier.includes("@")
      ? Effect.gen(function* () {
          const resolved = yield* resolveEmailFilter(dir, normalizeEmail(identifier));
          const byEmail = resolved === null ? null : yield* read(resolved);
          return byEmail ?? (yield* read(identifier));
        })
      : read(identifier);

    if (subject === null) return yield* new AdminUserNotFound();

    // Identity is joined through the SAME batched seam the list uses, so the
    // single read reports exactly the fields the list would for this row.
    const identities = yield* resolveIdentities(dir.identities, [subject.externalId]);
    return { user: toUserWithConnections(subject, identities) };
  });

export const listUserConnections = (
  admin: ExecutorAdmin,
  externalId: string,
): Effect.Effect<typeof AdminUserConnectionsResponse.Type, AdminUsersError> =>
  admin.listSubjectConnections(externalId).pipe(
    Effect.map((connections) => ({ connections: connections.map(toConnection) })),
    Effect.mapError(readFailed("connections")),
  );
