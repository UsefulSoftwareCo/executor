// ---------------------------------------------------------------------------
// The membership mirror's RECONCILER (`workos-events-sync.ts`) and the
// webhook that pokes it (`workos-webhook.ts`), against the real PGlite
// Postgres every cloud unit test runs on (scripts/test-globalsetup.ts).
// WorkOS is a fake `WorkOSClient` for the Events API (the emulator has no
// events route); the signature check runs the REAL client's verifier over a
// locally computed HMAC, because that check is the webhook's only
// authentication.
//
// What this pins:
//   - every followed event type lands in the mirror: user created/updated/
//     deleted, membership created/updated/deleted, organization renamed
//   - an older event never regresses a newer row (`stale`), a delete of an
//     absent row is `absent`, and `organization.deleted` is `ignored`
//   - a membership for an organization the mirror has never seen mirrors
//     the org first (one WorkOS read), so the foreign key holds; one whose
//     org WorkOS no longer has is skipped and the cursor still advances,
//     while a transient WorkOS failure still fails the run
//   - `organization.updated` never inserts an org the mirror does not hold
//   - a run pages from the persisted cursor, commits after every page, and
//     STOPS when another run moves the cursor under it — with NOTHING from
//     the contended page written (a lagging run cannot resurrect a
//     membership the leading run already deleted)
//   - the webhook accepts only a genuinely signed delivery, never applies
//     it, and refuses everything when no signing secret is configured
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { sql } from "drizzle-orm";
import { Effect, Exit, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type { Organization, OrganizationMembership, User } from "@workos-inc/node/worker";

import { MemberDirectory } from "@executor-js/api/server";

import { DbService } from "../db/db";
import { UserStoreService } from "./context";
import { WorkOSError } from "./errors";
import { cloudMemberDirectoryLayer } from "./member-directory";
import { WorkOSClient, type WorkOSClientService, type WorkOSListEventsOptions } from "./workos";
import {
  planEvent,
  syncWorkOsEvents,
  type WorkOsEventOutcome,
  type WorkOsEventsSyncReport,
  type WorkOsMirroredEvent,
} from "./workos-events-sync";
import { WorkOsMirror, WorkOsMirrorWrite, mirrorMembershipFromWorkOs } from "./workos-mirror";
import { WORKOS_WEBHOOK_PATH, makeWorkOsWebhookRoute } from "./workos-webhook";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const T3 = "2026-01-03T00:00:00.000Z";

// Synthetic identities only; every test mints its own ids so the shared test
// database never couples two tests.
const freshId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const workosUser = (id: string, overrides: Partial<User> = {}): User => ({
  object: "user",
  id,
  email: `${id}@placeholder.test`,
  emailVerified: true,
  firstName: "Ada",
  lastName: "Placeholder",
  profilePictureUrl: null,
  lastSignInAt: T1,
  locale: null,
  createdAt: T1,
  updatedAt: T1,
  externalId: null,
  metadata: {},
  ...overrides,
});

const workosMembership = (
  userId: string,
  organizationId: string,
  overrides: Partial<OrganizationMembership> = {},
): OrganizationMembership => ({
  object: "organization_membership",
  id: `om_${userId}_${organizationId}`,
  userId,
  organizationId,
  organizationName: `Org ${organizationId}`,
  status: "active",
  directoryManaged: false,
  createdAt: T1,
  updatedAt: T1,
  customAttributes: {},
  role: { slug: "member" },
  ...overrides,
});

const workosOrganization = (id: string, name: string): Organization => ({
  object: "organization",
  id,
  name,
  allowProfilesOutsideOrganization: false,
  domains: [],
  createdAt: T1,
  updatedAt: T1,
  externalId: null,
  metadata: {},
});

const userEvent = (
  event: "user.created" | "user.updated" | "user.deleted",
  data: User,
  id = freshId("event"),
): WorkOsMirroredEvent => ({
  id,
  event,
  data,
  createdAt: T1,
  context: undefined,
});

const membershipEvent = (
  event:
    | "organization_membership.created"
    | "organization_membership.updated"
    | "organization_membership.deleted",
  data: OrganizationMembership,
  id = freshId("event"),
): WorkOsMirroredEvent => ({
  id,
  event,
  data,
  createdAt: T1,
  context: undefined,
});

const organizationEvent = (
  event: "organization.updated" | "organization.deleted",
  data: Organization,
  id = freshId("event"),
): WorkOsMirroredEvent => ({
  id,
  event,
  data,
  createdAt: T1,
  context: undefined,
});

/**
 * A `WorkOSClient` whose every method is one of `methods`; anything else is
 * an unexpected call and dies, so a reconciler that silently adds a WorkOS
 * read fails the test instead of passing on a fake.
 */
const stubWorkOS = (methods: Partial<WorkOSClientService>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) =>
        (methods as Record<PropertyKey, unknown>)[prop] ??
        (() => Effect.die(`unexpected WorkOSClient.${String(prop)} call`)),
    }),
  );

const DbLive = DbService.Live;
const MirrorServices = Layer.mergeAll(
  WorkOsMirror.Live,
  UserStoreService.Live,
  cloudMemberDirectoryLayer,
).pipe(Layer.provideMerge(DbLive));

type Services = WorkOsMirror | UserStoreService | MemberDirectory | DbService | WorkOSClient;

const run = <A, E>(
  body: Effect.Effect<A, E, Services>,
  workos: Layer.Layer<WorkOSClient> = stubWorkOS({}),
) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Layer.mergeAll(MirrorServices, workos)), Effect.scoped),
  );

const seedOrganization = (id: string) =>
  Effect.flatMap(UserStoreService.asEffect(), (users) =>
    users.use("upsertOrganization", (s) => s.upsertOrganization({ id, name: `Org ${id}` })),
  );

const readOrganization = (id: string) =>
  Effect.flatMap(UserStoreService.asEffect(), (users) =>
    users.use("getOrganization", (s) => s.getOrganization(id)),
  );

const readMembership = (accountId: string, organizationId: string) =>
  Effect.flatMap(MemberDirectory.asEffect(), (directory) =>
    directory.membership(accountId, organizationId),
  );

/**
 * Apply one event the way a run does — plan it, then apply it as a one-event
 * page under the cursor CAS — and report the event's outcome. The cursor is
 * instance-wide; each apply moves it to a fresh id, which is what a run does.
 */
const applyEvent = (event: WorkOsMirroredEvent) =>
  Effect.gen(function* () {
    const mirror = yield* WorkOsMirror;
    const write = yield* planEvent(event);
    const prev = yield* mirror.getCursor();
    const outcomes = yield* mirror.applyPage(prev, freshId("event"), Option.toArray(write));
    expect(Option.isSome(outcomes), "no other run contends in a single-event apply").toBe(true);
    const outcome: WorkOsEventOutcome = Option.isNone(write)
      ? "ignored"
      : (Option.getOrElse(outcomes, () => [])[0] ?? "ignored");
    return outcome;
  });

describe("applyEvent", () => {
  it("mirrors a user, refreshes it, refuses an older update, and deletes it", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(userId, org)),
        );

        const created = yield* applyEvent(
          userEvent("user.created", workosUser(userId, { firstName: "Grace", updatedAt: T2 })),
        );
        const afterCreate = yield* readMembership(userId, org);
        const updated = yield* applyEvent(
          userEvent("user.updated", workosUser(userId, { firstName: "Newer", updatedAt: T3 })),
        );
        const afterUpdate = yield* readMembership(userId, org);
        const stale = yield* applyEvent(
          userEvent("user.updated", workosUser(userId, { firstName: "Stale", updatedAt: T1 })),
        );
        const afterStale = yield* readMembership(userId, org);
        const deleted = yield* applyEvent(userEvent("user.deleted", workosUser(userId)));
        const afterDelete = yield* readMembership(userId, org);
        const deletedAgain = yield* applyEvent(userEvent("user.deleted", workosUser(userId)));
        return {
          created,
          afterCreate,
          updated,
          afterUpdate,
          stale,
          afterStale,
          deleted,
          afterDelete,
          deletedAgain,
        };
      }),
    );
    expect(result.created).toBe("applied");
    expect(result.afterCreate?.name).toBe("Grace Placeholder");
    expect(result.updated).toBe("applied");
    expect(result.afterUpdate?.name).toBe("Newer Placeholder");
    expect(result.stale, "an event older than the stored row is reported stale").toBe("stale");
    expect(result.afterStale?.name, "and leaves the newer row untouched").toBe("Newer Placeholder");
    expect(result.deleted).toBe("applied");
    expect(result.afterDelete, "deleting the user cascades its membership").toBeNull();
    expect(result.deletedAgain, "a replayed delete finds nothing").toBe("absent");
  });

  it("mirrors a membership, updates its role, refuses an older update, and deletes it", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        const created = yield* applyEvent(
          membershipEvent(
            "organization_membership.created",
            workosMembership(userId, org, { status: "pending" }),
          ),
        );
        const afterCreate = yield* readMembership(userId, org);
        const updated = yield* applyEvent(
          membershipEvent(
            "organization_membership.updated",
            workosMembership(userId, org, {
              role: { slug: "admin" },
              updatedAt: T3,
            }),
          ),
        );
        const afterUpdate = yield* readMembership(userId, org);
        const stale = yield* applyEvent(
          membershipEvent(
            "organization_membership.updated",
            workosMembership(userId, org, {
              role: { slug: "member" },
              status: "inactive",
              updatedAt: T2,
            }),
          ),
        );
        const afterStale = yield* readMembership(userId, org);
        const deleted = yield* applyEvent(
          membershipEvent("organization_membership.deleted", workosMembership(userId, org)),
        );
        const afterDelete = yield* readMembership(userId, org);
        const deletedAgain = yield* applyEvent(
          membershipEvent("organization_membership.deleted", workosMembership(userId, org)),
        );
        return {
          created,
          afterCreate,
          updated,
          afterUpdate,
          stale,
          afterStale,
          deleted,
          afterDelete,
          deletedAgain,
        };
      }),
    );
    expect(result.created).toBe("applied");
    expect(result.afterCreate).toMatchObject({
      membershipId: `om_${userId}_${org}`,
      status: "pending",
      role: "member",
    });
    expect(result.updated).toBe("applied");
    expect(result.afterUpdate).toMatchObject({
      status: "active",
      role: "admin",
    });
    expect(result.stale).toBe("stale");
    expect(result.afterStale).toMatchObject({
      status: "active",
      role: "admin",
    });
    expect(result.deleted).toBe("applied");
    expect(result.afterDelete).toBeNull();
    expect(result.deletedAgain).toBe("absent");
  });

  it("mirrors the organization first when a membership names one the mirror has never seen", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const reads: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        const outcome = yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(userId, org)),
        );
        const organization = yield* readOrganization(org);
        const membership = yield* readMembership(userId, org);
        return { outcome, organization, membership };
      }),
      stubWorkOS({
        getOrganization: (id) => {
          reads.push(id);
          return Effect.succeed(workosOrganization(id, "Dashboard Org"));
        },
      }),
    );
    expect(reads, "exactly one WorkOS read, for the unknown org").toEqual([org]);
    expect(result.outcome).toBe("applied");
    expect(result.organization?.name).toBe("Dashboard Org");
    expect(result.membership?.membershipId).toBe(`om_${userId}_${org}`);
  });

  it("skips a membership whose organization WorkOS no longer has, but fails on a transient WorkOS failure", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const event = membershipEvent("organization_membership.created", workosMembership(userId, org));
    const gone = await run(
      Effect.gen(function* () {
        const outcome = yield* applyEvent(event);
        const organization = yield* readOrganization(org);
        const membership = yield* readMembership(userId, org);
        return { outcome, organization, membership };
      }),
      stubWorkOS({ getOrganization: () => Effect.fail(new WorkOSError({ status: 404 })) }),
    );
    expect(gone.outcome, "an org WorkOS has deleted is a skipped event, not a failed run").toBe(
      "ignored",
    );
    expect(gone.organization).toBeNull();
    expect(gone.membership).toBeNull();

    const blip = await Effect.runPromiseExit(
      Effect.exit(planEvent(event)).pipe(
        Effect.provide(
          Layer.mergeAll(
            MirrorServices,
            stubWorkOS({ getOrganization: () => Effect.fail(new WorkOSError({ status: 503 })) }),
          ),
        ),
        Effect.scoped,
      ),
    );
    const unreachable = await Effect.runPromiseExit(
      Effect.exit(planEvent(event)).pipe(
        Effect.provide(
          Layer.mergeAll(
            MirrorServices,
            stubWorkOS({ getOrganization: () => Effect.fail(new WorkOSError({})) }),
          ),
        ),
        Effect.scoped,
      ),
    );
    expect(
      Exit.isSuccess(blip) && Exit.isFailure(blip.value),
      "a 5xx keeps the event for retry",
    ).toBe(true);
    expect(
      Exit.isSuccess(unreachable) && Exit.isFailure(unreachable.value),
      "a network failure keeps the event for retry",
    ).toBe(true);
  });

  it("does not create an organization row from organization.updated for an org the mirror has never seen", async () => {
    const org = freshId("org");
    const result = await run(
      Effect.gen(function* () {
        const outcome = yield* applyEvent(
          organizationEvent("organization.updated", workosOrganization(org, "Purged Org")),
        );
        const organization = yield* readOrganization(org);
        return { outcome, organization };
      }),
    );
    expect(result.outcome, "a rename of an unmirrored org is reported absent").toBe("absent");
    expect(
      result.organization,
      "and mints no row (no resurrection after cloud's purge)",
    ).toBeNull();
  });

  it("renames the organization on organization.updated and keeps everything on organization.deleted", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        const seeded = yield* seedOrganization(org);
        yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(userId, org)),
        );
        const renamed = yield* applyEvent(
          organizationEvent("organization.updated", workosOrganization(org, "Renamed Org")),
        );
        const afterRename = yield* readOrganization(org);
        const deleted = yield* applyEvent(
          organizationEvent("organization.deleted", workosOrganization(org, "Renamed Org")),
        );
        const orgAfterDelete = yield* readOrganization(org);
        const membershipAfterDelete = yield* readMembership(userId, org);
        return {
          seeded,
          renamed,
          afterRename,
          deleted,
          orgAfterDelete,
          membershipAfterDelete,
        };
      }),
    );
    expect(result.renamed).toBe("applied");
    expect(result.afterRename?.name).toBe("Renamed Org");
    expect(result.afterRename?.slug, "the slug is stable across renames").toBe(result.seeded.slug);
    expect(result.deleted, "organization.deleted is logged, never applied").toBe("ignored");
    expect(result.orgAfterDelete?.name).toBe("Renamed Org");
    expect(result.membershipAfterDelete).not.toBeNull();
  });
});

describe("syncWorkOsEvents", () => {
  /** Pin the instance-wide cursor to a fresh known value, whatever it was. */
  const pinCursor = (value: string) =>
    Effect.gen(function* () {
      const mirror = yield* WorkOsMirror;
      const before = yield* mirror.getCursor();
      const moved = yield* mirror.applyPage(before, value, []);
      expect(Option.isSome(moved)).toBe(true);
      return value;
    });

  type Page = {
    readonly data: readonly WorkOsMirroredEvent[];
    readonly after: string | null;
  };

  /**
   * A fake Events API serving `pages` in order, recording every request's
   * paging options; `onPage` runs before the nth page is returned (the CAS
   * contention test moves the cursor from there). `methods` adds any other
   * WorkOS call the run under test is allowed to make.
   */
  const eventsApi = (
    pages: readonly Page[],
    requests: WorkOSListEventsOptions[],
    onPage: (index: number) => Effect.Effect<void, unknown, WorkOsMirror> = () => Effect.void,
    methods: Partial<WorkOSClientService> = {},
  ) =>
    Effect.map(WorkOsMirror.asEffect(), (mirror) =>
      stubWorkOS({
        ...methods,
        listEvents: (options) =>
          Effect.gen(function* () {
            const index = requests.length;
            requests.push(options);
            yield* onPage(index).pipe(Effect.provideService(WorkOsMirror, mirror), Effect.orDie);
            const page = pages[index] ?? { data: [], after: null };
            return {
              object: "list" as const,
              data: [...page.data],
              listMetadata: { before: null, after: page.after },
            };
          }),
      }),
    );

  const sync = (
    workos: Layer.Layer<WorkOSClient>,
  ): Effect.Effect<WorkOsEventsSyncReport, unknown, Services> =>
    syncWorkOsEvents().pipe(Effect.provide(workos));

  it("pages from the persisted cursor, applies every event, and commits the last id of each page", async () => {
    const org = freshId("org");
    const a = freshId("user");
    const b = freshId("user");
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        const start = yield* pinCursor(freshId("event"));
        const pages: Page[] = [
          {
            data: [
              userEvent("user.created", workosUser(a), `${start}_1`),
              membershipEvent(
                "organization_membership.created",
                workosMembership(a, org),
                `${start}_2`,
              ),
            ],
            after: `${start}_2`,
          },
          {
            data: [
              membershipEvent(
                "organization_membership.created",
                workosMembership(b, org),
                `${start}_3`,
              ),
              organizationEvent(
                "organization.deleted",
                workosOrganization(org, "Gone"),
                `${start}_4`,
              ),
            ],
            after: null,
          },
        ];
        const workos = yield* eventsApi(pages, requests);
        const report = yield* sync(workos);
        const mirror = yield* WorkOsMirror;
        const cursor = yield* mirror.getCursor();
        const members = yield* Effect.flatMap(MemberDirectory.asEffect(), (d) => d.members(org));
        return { start, report, cursor, members };
      }),
    );
    expect(requests.map((r) => r.after)).toEqual([result.start, `${result.start}_2`]);
    expect(requests[0]).toMatchObject({ order: "asc", limit: 100 });
    expect(requests[0]?.rangeStart, "a run with a cursor never sends rangeStart").toBeUndefined();
    expect(result.report).toMatchObject({
      pages: 2,
      events: 4,
      applied: 3,
      ignored: 1,
      stopped: "drained",
      cursor: `${result.start}_4`,
    });
    expect(result.cursor).toBe(`${result.start}_4`);
    expect(result.members.map((m) => m.accountId).sort()).toEqual([a, b].sort());
  });

  it("starts one hour back when no cursor exists", async () => {
    const requests: WorkOSListEventsOptions[] = [];
    const before = Date.now();
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        // The cursor row is instance-wide: clear it for this test only, then
        // let the run mint it.
        const current = yield* mirror.getCursor();
        yield* Effect.flatMap(DbService.asEffect(), ({ db }) =>
          Effect.promise(() => db.execute(sql`delete from workos_sync where id = 'events'`)),
        );
        const start = freshId("event");
        const workos = yield* eventsApi(
          [
            {
              data: [userEvent("user.created", workosUser(freshId("user")), start)],
              after: null,
            },
          ],
          requests,
        );
        const report = yield* sync(workos);
        const cursor = yield* mirror.getCursor();
        return { current, report, cursor, start };
      }),
    );
    const after = Date.now();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.after).toBeUndefined();
    const rangeStart = Date.parse(requests[0]?.rangeStart ?? "");
    const oneHour = 60 * 60 * 1000;
    expect(rangeStart).toBeGreaterThanOrEqual(before - oneHour);
    expect(rangeStart).toBeLessThanOrEqual(after - oneHour);
    expect(result.report.stopped).toBe("drained");
    expect(result.cursor, "the first run mints the cursor").toBe(result.start);
  });

  it("stops when another run moves the cursor under it, writing nothing from the contended page", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        const mirror = yield* WorkOsMirror;
        const start = yield* pinCursor(freshId("event"));
        const intruder = `${start}_intruder`;
        // This run's page carries a membership update that the leading run
        // has already applied AND deleted (the member was revoked). If the
        // lagging run's page landed, the revoked member would be back.
        const pages: Page[] = [
          {
            data: [
              membershipEvent(
                "organization_membership.updated",
                workosMembership(userId, org, { role: { slug: "admin" } }),
                `${start}_1`,
              ),
            ],
            after: `${start}_1`,
          },
          {
            data: [userEvent("user.created", workosUser(freshId("user")), `${start}_2`)],
            after: null,
          },
        ];
        // While this run is reading its first page, "another run" applies the
        // same page, then the membership's deletion, and commits both.
        const workos = yield* eventsApi(pages, requests, (index) =>
          index === 0
            ? Effect.gen(function* () {
                const leading = yield* WorkOsMirror;
                yield* leading.applyPage(start, `${start}_1`, [
                  WorkOsMirrorWrite.UpsertMembership({
                    membership: mirrorMembershipFromWorkOs(workosMembership(userId, org)),
                  }),
                ]);
                yield* leading.applyPage(`${start}_1`, intruder, [
                  WorkOsMirrorWrite.DeleteMembership({ membershipId: `om_${userId}_${org}` }),
                ]);
              })
            : Effect.void,
        );
        const report = yield* sync(workos);
        const cursor = yield* mirror.getCursor();
        const membership = yield* readMembership(userId, org);
        return { report, cursor, intruder, membership };
      }),
    );
    expect(requests, "the second page is never read").toHaveLength(1);
    expect(result.report).toMatchObject({
      pages: 1,
      events: 1,
      applied: 0,
      stopped: "cursor_contended",
    });
    expect(result.cursor, "the other run's cursor stands").toBe(result.intruder);
    expect(result.membership, "the revoked membership is not resurrected").toBeNull();
  });

  it("advances the cursor past a membership event whose organization WorkOS no longer has", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        const start = yield* pinCursor(freshId("event"));
        const workos = yield* eventsApi(
          [
            {
              data: [
                membershipEvent(
                  "organization_membership.created",
                  workosMembership(userId, org),
                  `${start}_1`,
                ),
                organizationEvent(
                  "organization.deleted",
                  workosOrganization(org, "Gone"),
                  `${start}_2`,
                ),
              ],
              after: null,
            },
          ],
          requests,
          () => Effect.void,
          { getOrganization: () => Effect.fail(new WorkOSError({ status: 404 })) },
        );
        const report = yield* sync(workos);
        const mirror = yield* WorkOsMirror;
        const cursor = yield* mirror.getCursor();
        const organization = yield* readOrganization(org);
        return { start, report, cursor, organization };
      }),
    );
    expect(result.report).toMatchObject({
      pages: 1,
      events: 2,
      applied: 0,
      ignored: 2,
      stopped: "drained",
      cursor: `${result.start}_2`,
    });
    expect(result.cursor, "the stream is not stalled on the gone org").toBe(`${result.start}_2`);
    expect(result.organization).toBeNull();
  });
});

describe("workos webhook", () => {
  const SECRET = "whsec_placeholder_signing_secret";

  const handlerFor = (deps: {
    readonly secret: string | undefined;
    readonly detached: Promise<void>[];
    readonly synced: number[];
  }) =>
    HttpRouter.toWebHandler(
      makeWorkOsWebhookRoute({
        secret: deps.secret,
        detach: (work) => {
          deps.detached.push(work);
        },
        sync: () => {
          deps.synced.push(1);
          return Promise.resolve();
        },
      }).pipe(
        // The REAL client: its `webhooks.constructEvent` is the signature check
        // under test. The api key / client id it reads are the vitest env's.
        Layer.provideMerge(WorkOSClient.Default),
        Layer.provideMerge(HttpServer.layerServices),
      ),
      { disableLogger: true },
    ).handler;

  const delivery = {
    id: "event_placeholder",
    event: "user.created",
    created_at: T1,
    context: {},
    data: {
      object: "user",
      id: "user_placeholder",
      email: "member@placeholder.test",
      email_verified: true,
      first_name: "Ada",
      last_name: "Placeholder",
      profile_picture_url: null,
      last_sign_in_at: T1,
      locale: null,
      created_at: T1,
      updated_at: T1,
      external_id: null,
      metadata: {},
    },
  };

  /** The `WorkOS-Signature` header WorkOS sends: `t=<ms>, v1=<hmac-sha256 hex>`. */
  const signature = (body: string, secret: string, timestamp = Date.now()) =>
    `t=${timestamp}, v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

  const post = (body: string, headers: Record<string, string>) =>
    new Request(`http://test.local${WORKOS_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  const deps = (secret: string | undefined) => ({
    secret,
    detached: [] as Promise<void>[],
    synced: [] as number[],
  });

  it("accepts a genuinely signed delivery and pokes the reconciler past the response", async () => {
    const d = deps(SECRET);
    const body = JSON.stringify(delivery);
    const response = await handlerFor(d)(
      post(body, { "workos-signature": signature(body, SECRET) }),
    );
    expect(response.status).toBe(200);
    expect(d.synced, "one reconciler pass").toHaveLength(1);
    expect(d.detached, "handed to the platform, not awaited in the response").toHaveLength(1);
  });

  it("rejects a delivery signed with another secret, a tampered body, and a missing header", async () => {
    const d = deps(SECRET);
    const handler = handlerFor(d);
    const body = JSON.stringify(delivery);

    const wrongSecret = await handler(
      post(body, { "workos-signature": signature(body, "whsec_other") }),
    );
    const tampered = await handler(
      post(body.replace("user_placeholder", "user_tampered"), {
        "workos-signature": signature(body, SECRET),
      }),
    );
    const unsigned = await handler(post(body, {}));
    const notJson = await handler(
      post("not json", { "workos-signature": signature("not json", SECRET) }),
    );
    const expired = await handler(
      post(body, {
        "workos-signature": signature(body, SECRET, Date.now() - 10 * 60 * 1000),
      }),
    );

    expect([
      wrongSecret.status,
      tampered.status,
      unsigned.status,
      notJson.status,
      expired.status,
    ]).toEqual([400, 400, 400, 400, 400]);
    expect(d.synced, "nothing is poked").toEqual([]);
  });

  it("refuses every delivery while no signing secret is configured", async () => {
    const d = deps(undefined);
    const body = JSON.stringify(delivery);
    const response = await handlerFor(d)(
      post(body, { "workos-signature": signature(body, SECRET) }),
    );
    expect(response.status).toBe(503);
    expect(d.synced).toEqual([]);
  });
});
