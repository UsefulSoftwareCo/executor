/**
 * The v2 identity a v1 organization moves into (`notes/v1-import.md`, Identity): a Better Auth user
 * per imported member, merged by email only when both sides verified it (decision 13), the
 * organization, and a membership per member. Each write records its import map row in the same
 * transaction, so a rerun finds it and never creates a second copy.
 */
import { organizationHandle, organizationSlugMaxLength } from "@executor-js/hosted-server";
import { Effect, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import type { V1IntoMode } from "../../contracts/v1-import-run.ts";
import { ItemFailed } from "./items.ts";
import type { PlannedMember } from "./members.ts";
import { sourceHash, type ImportStore } from "./store.ts";

const Users = Schema.Array(Schema.Struct({ id: Schema.String, emailVerified: Schema.Boolean }));
const Ids = Schema.Array(Schema.Struct({ id: Schema.String }));
const Slugs = Schema.Array(Schema.Struct({ slug: Schema.String }));

/** What becomes of a member's v1 user in v2. */
export type UserMatch =
  /** A v2 user who verified the same email: the member keeps that account. */
  | { readonly kind: "merge"; readonly user: string }
  /** No v2 user has the email: the import creates one. */
  | { readonly kind: "create" }
  /**
   * A v2 user has the email but has not verified it. v2 emails are unique, so the member can be
   * neither merged nor created beside them; the org does not convert until this is resolved.
   */
  | { readonly kind: "conflict" };

const unavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new V1ImportUnavailable()));

/**
 * The v2 user an email belongs to. Better Auth stores every email lowercased (its internal
 * adapter lowercases on create and update), as the import does, so the lowercased email is
 * compared as stored and the unique index on `email` finds it.
 */
export const matchUser = (sql: SqlClient.SqlClient, email: string) =>
  sql`select id, "emailVerified" from "user" where email = ${email.toLowerCase()}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Users)),
    Effect.map((found): UserMatch => {
      const user = found[0];
      if (user === undefined) return { kind: "create" };
      return user.emailVerified ? { kind: "merge", user: user.id } : { kind: "conflict" };
    }),
    unavailable,
  );

/** A suffix derived from `label`, an id and an attempt with the deployment's key, as hex. */
const slugSuffix = (
  key: Redacted.Redacted<string>,
  label: "v1-import-slug" | "v2-rename-slug",
  id: string,
  attempt: number,
) =>
  Effect.promise(async () => {
    const hmac = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(Redacted.value(key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode(JSON.stringify([label, id, attempt])),
    );
    return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

/** The start of a suffixed slug: short enough for `-` and a 6-character suffix. */
const suffixBase = (slug: string) =>
  organizationHandle(slug, organizationSlugMaxLength - 7) || "team";

/**
 * The v2 slug a v1 slug starts from: the v1 slug when it satisfies v2's rule, up to its full
 * length, and otherwise its handle, short enough for a suffix.
 */
export const slugBase = (slug: string) =>
  organizationHandle(slug) === slug ? slug : suffixBase(slug);

/**
 * The v2 slugs an organization tries, in order: the v1 slug when it satisfies v2's rule, then the
 * same with a suffix derived from the v1 organization's id. Derived, not random, so a dry run
 * reports the slug an import would take; keyed with a deployment secret, so nobody can tell the
 * suffix from the public code and take it first. `reserved` leaves out the unsuffixed slug, which
 * another v1 organization holds exactly and takes when it moves.
 */
export const slugCandidates = (
  key: Redacted.Redacted<string>,
  organization: string,
  slug: string,
  reserved: boolean,
) =>
  Effect.gen(function* () {
    const candidates = reserved ? [] : [slugBase(slug)];
    const base = suffixBase(slug);
    for (let attempt = 1; attempt < 5; attempt++)
      candidates.push(
        `${base}-${(yield* slugSuffix(key, "v1-import-slug", organization, attempt)).slice(0, 6)}`,
      );
    return candidates;
  });

/**
 * A v2 organization the operator listed to give up the slug a v1 organization moves to
 * (`notes/v1-import.md`, "Slug displacement"): the holder is renamed to `to`, and the v1
 * organization takes `from`, in one transaction.
 */
export interface Displacement {
  readonly kind: "rename";
  readonly holder: string;
  readonly from: string;
  readonly to: string;
}

/** A listed displacement that does not apply, and why; the organization takes its candidates. */
export interface DisplacementRefused {
  readonly kind: "refused";
  readonly holder: string;
  readonly refused: string;
}

/**
 * The listed holder's rename: when it holds `slug`, the first of its suffixed slugs, derived from
 * its id with the deployment's key, that no v2 organization has and no live v1 organization has
 * exactly (`liveInV1`), so a later move does not meet it again.
 */
export const plannedDisplacement = <E>(
  sql: SqlClient.SqlClient,
  key: Redacted.Redacted<string>,
  liveInV1: (slug: string) => Effect.Effect<boolean, E>,
  holder: string,
  slug: string,
): Effect.Effect<Displacement | DisplacementRefused, E | V1ImportUnavailable> =>
  Effect.gen(function* () {
    const held = yield* sql`select id from organization where slug = ${slug}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ids)),
      unavailable,
    );
    if (held[0]?.id !== holder)
      return {
        kind: "refused",
        holder,
        refused: `The listed v2 organization does not hold ${slug}${held[0] === undefined ? ", which is free" : ""}.`,
      } satisfies DisplacementRefused;
    // v1 forwards a moved organization to its v2 slug, so another import keeps its own.
    const imported = yield* sql`
      select v2_id as id from private_v1_import_map
      where v1_kind = 'organization' and status = 'imported' and v2_id = ${holder}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)), unavailable);
    if (imported.length > 0)
      return {
        kind: "refused",
        holder,
        refused:
          "The listed v2 organization is another v1 organization's import, which v1 forwards to by its slug.",
      } satisfies DisplacementRefused;
    const base = suffixBase(slug);
    for (let attempt = 1; attempt < 5; attempt++) {
      const to = `${base}-${(yield* slugSuffix(key, "v2-rename-slug", holder, attempt)).slice(0, 6)}`;
      const taken = yield* sql`select slug from organization where slug = ${to}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Slugs)),
        unavailable,
      );
      if (taken.length === 0 && !(yield* liveInV1(to)))
        return { kind: "rename", holder, from: slug, to } satisfies Displacement;
    }
    return {
      kind: "refused",
      holder,
      refused: "Every new slug for the listed v2 organization is taken.",
    } satisfies DisplacementRefused;
  });

/** The v2 slug a v1 slug becomes: the first candidate no v2 organization has. */
export const plannedSlug = (
  sql: SqlClient.SqlClient,
  candidates: readonly string[],
  slug: string,
) =>
  Effect.gen(function* () {
    const taken = new Set(
      (yield* sql`select slug from organization where ${sql.in("slug", candidates)}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Slugs)),
        unavailable,
      )).map((row) => row.slug),
    );
    const free = candidates.find((candidate) => !taken.has(candidate));
    return free === undefined
      ? { slug: null, changed: true }
      : { slug: free, changed: free !== slug };
  });

const conflict = () =>
  new ItemFailed({
    reason:
      "A v2 account has this member's email but has not verified it, so the member can be neither merged nor added.",
  });

/**
 * The member's v2 user: the one an earlier run recorded, a verified v2 user of the same email, or
 * a new one with a verified email and no password, who signs in with a social provider, an email
 * code or SSO. A new user is not queued for the welcome email: the row the user trigger queues is
 * removed in the same transaction, before any delivery can see it.
 */
export const importUser = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  organization: string,
  member: PlannedMember,
  profile: { readonly email: string; readonly name: string },
) =>
  Effect.gen(function* () {
    const recorded = yield* store.find("user", member.user);
    if (recorded?.status === "imported" && recorded.v2_id !== null) return recorded.v2_id;
    const hash = yield* sourceHash(profile.email);
    const match = yield* matchUser(sql, profile.email);
    if (match.kind === "conflict") return yield* conflict();
    if (match.kind === "merge") {
      yield* store.record({
        organization,
        kind: "user",
        id: member.user,
        result: { status: "imported", v2Kind: "merged_user", v2Id: match.user },
        hash,
      });
      return match.user;
    }
    const id = yield* Effect.sync(() => crypto.randomUUID());
    const created = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql`
            insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
            values (${id}, ${profile.name}, ${profile.email}, true, null, now(), now())
            on conflict do nothing returning id
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)));
          if (inserted[0] === undefined) return false;
          yield* sql`delete from cloud_welcome_email where user_id = ${id}`;
          yield* store.record({
            organization,
            kind: "user",
            id: member.user,
            result: { status: "imported", v2Kind: "user", v2Id: id },
            hash,
          });
          return true;
        }),
      )
      .pipe(unavailable);
    if (created) return id;
    // Someone signed up with the email meanwhile: decide again from their account.
    const again = yield* matchUser(sql, profile.email);
    if (again.kind !== "merge") return yield* conflict();
    yield* store.record({
      organization,
      kind: "user",
      id: member.user,
      result: { status: "imported", v2Kind: "merged_user", v2Id: again.user },
      hash,
    });
    return again.user;
  });

/**
 * The member's membership of the imported organization. The owner's comes with the organization.
 * Inserted directly, as an imported membership bypasses the Free plan's member limit.
 */
export const importMembership = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  input: {
    readonly organization: string;
    readonly target: string;
    readonly member: PlannedMember;
    readonly user: string;
  },
) =>
  Effect.gen(function* () {
    const recorded = yield* store.find("membership", input.member.membership);
    if (recorded?.status === "imported" && recorded.v2_id !== null) return recorded.v2_id;
    const id = yield* Effect.sync(() => crypto.randomUUID());
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql`
            select id from member where "organizationId" = ${input.target} and "userId" = ${input.user}
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)));
          const member =
            existing[0]?.id ??
            (yield* sql`
              insert into member (id, "organizationId", "userId", role, "createdAt")
              values (${id}, ${input.target}, ${input.user}, ${input.member.role}, now())
              returning id
            `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids))))[0]?.id;
          if (member === undefined) return yield* new V1ImportUnavailable();
          yield* store.record({
            organization: input.organization,
            kind: "membership",
            id: input.member.membership,
            result: {
              status: "imported",
              v2Kind: existing[0] === undefined ? "member" : "existing_member",
              v2Id: member,
            },
            hash: yield* sourceHash(input.member.role),
          });
          return member;
        }),
      )
      .pipe(unavailable);
  });

/**
 * The v2 kind of the map row of a v1 organization moved into an existing v2 organization its owner
 * owns (`notes/v1-import.md`, decision 32). The import did not create it, so a rollback keeps it and
 * removes only what the import added to it.
 */
export const existingOrganization = "existing_organization";

/** The note on an organization's map row when it moved into an existing v2 organization. */
const intoNotes: Record<V1IntoMode, string> = {
  nothing_to_copy: "Moved into an existing v2 organization its member owns, with nothing to copy.",
  leave_v1_data:
    "Moved into an existing v2 organization its member owns, leaving its v1 data in v1.",
  copy_into_empty: "Imported into an existing v2 organization its owner owns, which was empty.",
};

/** The existing v2 organization a v1 organization moves into, and the v2 user its owner is. */
export interface Into {
  readonly kind: "into";
  readonly target: { readonly id: string; readonly name: string; readonly slug: string };
  readonly user: string;
}

/** A listed existing organization the v1 organization does not move into, and why. */
export interface IntoRefused {
  readonly kind: "refused";
  readonly refused: string;
}

const notOwner = "Its owner is not an owner of the listed v2 organization.";

/**
 * Whether the v1 organization's owner owns `target`, the existing v2 organization the operator
 * listed: their v2 user is the one an earlier run recorded, or else a v2 user who verified the same
 * email, never a new one. An earlier run that recorded the organization elsewhere refuses it too.
 */
export const intoOwner = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  input: {
    readonly organization: string;
    readonly target: string;
    /** The owner's WorkOS user id. */
    readonly member: string;
    readonly email: string;
  },
): Effect.Effect<Into | IntoRefused, V1ImportUnavailable> =>
  Effect.gen(function* () {
    const refused = (reason: string) => ({ kind: "refused", refused: reason }) as const;
    const recorded = yield* store.find("organization", input.organization);
    if (recorded?.status === "imported" && recorded.v2_id !== input.target)
      return refused("An earlier run recorded it against another v2 organization.");
    const mapped = yield* store.find("user", input.member);
    let user: string;
    if (mapped?.status === "imported" && mapped.v2_id !== null) user = mapped.v2_id;
    else {
      const match = yield* matchUser(sql, input.email);
      if (match.kind !== "merge")
        return refused(
          match.kind === "create"
            ? "Its owner has no v2 account."
            : "A v2 account has its owner's email but has not verified it.",
        );
      user = match.user;
    }
    const target = yield* store.target(input.target);
    if (target === undefined) return refused("The listed v2 organization does not exist.");
    const owners = yield* sql`
      select id from member
      where "organizationId" = ${target.id} and "userId" = ${user} and role = 'owner'
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)), unavailable);
    if (owners.length === 0) return refused(notOwner);
    return { kind: "into", target, user } satisfies Into;
  });

const Contents = Schema.Array(
  Schema.Struct({
    apps: Schema.Number,
    accounts: Schema.Number,
    connections: Schema.Number,
    schedules: Schema.Number,
  }),
);

/**
 * What is set up in a v2 organization, or undefined when nothing is: apps besides the Executor app
 * every organization gets, accounts besides its members' own Executor keys (both recorded in the
 * organization's metadata when it is set up), live MCP connections and schedules.
 */
export const setUpIn = (sql: SqlClient.SqlClient, organization: string) =>
  sql`
    select
      (select count(*)::int from executor_apps a where a.owner = 'organization:' || o.id
        and a.id is distinct from o.metadata::jsonb -> 'executorDefaults' ->> 'app') as apps,
      (select count(*)::int from executor_accounts a where a.owner = 'organization:' || o.id
        and not exists (
          select 1 from jsonb_each_text(coalesce(o.metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb)) k
          where k.value = a.id
        )) as accounts,
      (select count(*)::int from "mcpConnection" c where c.resource = o.id and not c.revoked) as connections,
      (select count(*)::int from executor_schedules s where s.owner = 'organization:' || o.id) as schedules
    from organization o where o.id = ${organization}
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Contents)),
    Effect.map(([found]) => {
      if (found === undefined) return undefined;
      const set = Object.entries(found).flatMap(([kind, count]) =>
        count === 0 ? [] : [`${kind}: ${count}`],
      );
      return set.length === 0 ? undefined : set.join(", ");
    }),
    unavailable,
  );

/**
 * Move the v1 organization into the existing v2 organization its owner owns (decision 32): record
 * the owner's v2 user and the organization's map row against it, in one transaction that holds the
 * owner's membership, so an owner who stopped owning it meanwhile records nothing. A first copy into
 * it requires it to have nothing set up yet (`setUpIn`), checked in the same transaction; with
 * `billingHold`, the transaction also holds its billing while the paid v1 subscription carries over,
 * as the statement that creates an organization does. Nothing else in the organization changes: not
 * its name, slug or members.
 */
export const importInto = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  input: {
    readonly organization: string;
    readonly target: string;
    readonly mode: V1IntoMode;
    readonly member: PlannedMember;
    readonly email: string;
    /** The paid v1 subscription its billing carries over from, as JSON, if any. */
    readonly billingHold: string | null;
  },
) =>
  Effect.gen(function* () {
    const decided = yield* intoOwner(sql, store, {
      organization: input.organization,
      target: input.target,
      member: input.member.user,
      email: input.email,
    });
    if (decided.kind === "refused") return yield* new ItemFailed({ reason: decided.refused });
    const userRecorded = (yield* store.find("user", input.member.user))?.status === "imported";
    const recorded = (yield* store.find("organization", input.organization))?.status === "imported";
    const userHash = yield* sourceHash(input.email);
    const hash = yield* sourceHash({ into: decided.target.id, mode: input.mode });
    const refusal = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const owner = yield* sql`
            select id from member
            where "organizationId" = ${decided.target.id} and "userId" = ${decided.user}
              and role = 'owner'
            for share
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)));
          if (owner.length === 0) return notOwner;
          if (!recorded && input.mode === "copy_into_empty") {
            const set = yield* setUpIn(sql, decided.target.id);
            if (set !== undefined) return `The listed v2 organization is not empty (${set}).`;
          }
          if (!userRecorded)
            yield* store.record({
              organization: input.organization,
              kind: "user",
              id: input.member.user,
              result: { status: "imported", v2Kind: "merged_user", v2Id: decided.user },
              hash: userHash,
            });
          if (!recorded)
            yield* store.record({
              organization: input.organization,
              kind: "organization",
              id: input.organization,
              result: {
                status: "imported",
                v2Kind: existingOrganization,
                v2Id: decided.target.id,
                note: intoNotes[input.mode],
              },
              hash,
            });
          if (input.billingHold !== null)
            yield* store.holdBilling(decided.target.id, {
              v1Organization: input.organization,
              subscription: input.billingHold,
            });
          return undefined;
        }),
      )
      .pipe(unavailable);
    if (refusal !== undefined) return yield* new ItemFailed({ reason: refusal });
    return decided;
  });

/**
 * The organization the v1 organization moves into: the one an earlier run recorded, or a new one
 * owned by `owner`, named after the v1 organization, at the first of its slug candidates that is
 * free (`candidates`). The map row commits with it.
 *
 * With a `displacement`, the same transaction first renames the holder, only while it still holds
 * the slug, and creates the organization at that slug; the map row's note records the rename. When
 * the holder no longer holds it, the organization takes its candidates and `displaced` says why.
 */
export const importOrganization = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  input: {
    readonly organization: string;
    readonly owner: string;
    readonly name: string;
    readonly slug: string;
    /** The slugs to try, in order (`slugCandidates`). */
    readonly candidates: readonly string[];
    /** The paid v1 subscription its billing carries over from, as JSON, if any. */
    readonly billingHold: string | null;
    /** The listed holder to rename first, or why that does not apply (`plannedDisplacement`). */
    readonly displacement?: Displacement | DisplacementRefused | undefined;
  },
) =>
  Effect.gen(function* () {
    const recorded = yield* store.find("organization", input.organization);
    if (recorded?.status === "imported" && recorded.v2_id !== null) {
      const target = yield* store.target(recorded.v2_id);
      if (target !== undefined) {
        if (input.billingHold !== null)
          yield* store.holdBilling(target.id, {
            v1Organization: input.organization,
            subscription: input.billingHold,
          });
        return { target, displaced: undefined };
      }
      return yield* new ItemFailed({ reason: "Its imported organization was removed in v2." });
    }
    const listed = input.displacement;
    const displacement = listed?.kind === "rename" ? listed : undefined;
    const hash = yield* sourceHash({ name: input.name, slug: input.slug });
    const created = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const renamed =
            displacement !== undefined && (yield* store.renameOrganization(displacement));
          const target = yield* store.createOrganization(
            input.owner,
            input.name,
            renamed ? [displacement.from] : input.candidates,
            input.billingHold === null
              ? null
              : { v1Organization: input.organization, subscription: input.billingHold },
          );
          if (target === undefined) {
            // The renamed holder's slug is ours in this transaction; never keep the rename alone.
            if (renamed) return yield* new V1ImportUnavailable();
            return undefined;
          }
          yield* store.record({
            organization: input.organization,
            kind: "organization",
            id: input.organization,
            result: {
              status: "imported",
              v2Kind: "organization",
              v2Id: target.id,
              ...(renamed
                ? {
                    note: `Renamed v2 organization ${displacement.holder} from ${displacement.from} to ${displacement.to} to take its slug.`,
                  }
                : {}),
            },
            hash,
          });
          return {
            target,
            displaced:
              listed === undefined
                ? undefined
                : listed.kind === "refused"
                  ? { organization: listed.holder, slug: null, reason: listed.refused }
                  : renamed
                    ? { organization: listed.holder, slug: listed.to }
                    : {
                        organization: listed.holder,
                        slug: null,
                        reason: `The listed v2 organization no longer held ${listed.from} when the organization was created.`,
                      },
          };
        }),
      )
      .pipe(unavailable);
    if (created === undefined)
      return yield* new ItemFailed({ reason: "Every v2 address for the organization is taken." });
    return created;
  });
