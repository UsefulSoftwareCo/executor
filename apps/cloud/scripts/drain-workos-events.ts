// ---------------------------------------------------------------------------
// Out-of-band reconciler run: replay the WorkOS Events API into the
// membership mirror from the persisted cursor until the stream is drained,
// over a plain postgres.js connection under bun — the SAME replay the
// Worker's every-minute cron runs (`src/auth/workos-events-replay.ts`).
//
//   bun run db:drain-workos-events:prod   # op run --env-file=.env.production
//
// Exists for the deploy gate (`scripts/ensure-workos-mirror-ready.ts`): the
// build that authorizes from the mirror trusts it only once the reconciler
// has drained the stream recently, and the gate must be able to MAKE that
// true itself rather than wait for a cron that may not be deployed yet —
// otherwise the reconciler build could only ever ship ahead of the gated
// one, by hand. Safe to run beside a live cron: a page is applied under the
// cursor's compare-and-set, so whichever run loses the stream writes
// nothing and stops. Runs until the stream is drained or another run owns
// it; a page budget bounds one pass, so a long backlog takes several. Exits
// 0 on a drain, 1 otherwise, with the reason.
// ---------------------------------------------------------------------------

import { drizzle } from "drizzle-orm/postgres-js";
import { Effect, Option } from "effect";
import postgres from "postgres";
import { WorkOS } from "@workos-inc/node";

import { makeUserStore } from "../src/auth/user-store";
import { replayWorkOsEvents, type WorkOsEventsSyncReport } from "../src/auth/workos-events-replay";
import { makeWorkOsMirrorStore } from "../src/auth/workos-mirror-store";
import { describeRefusedAttempt, waitForConnectionSlot } from "../src/db/too-many-connections";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const apiKey = process.env.WORKOS_API_KEY;
if (!apiKey) {
  console.error("WORKOS_API_KEY is not set");
  process.exit(1);
}

const usesLocalDatabase =
  connectionString.includes("127.0.0.1") || connectionString.includes("localhost");

const sql = postgres(connectionString, {
  max: 1,
  prepare: false,
  ...(usesLocalDatabase ? {} : { ssl: "require" as const }),
});
const db = drizzle(sql);
const workos = new WorkOS(apiKey);
const users = makeUserStore(db);

// The script boundary: raw SDK / driver promises lifted once, here. Only a
// 404 is the deterministic "gone" the replay acts on; every other failure
// fails the pass, as in the Worker (`src/auth/workos-events-sync.ts`).
const fromPromise = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => cause });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "status" in cause &&
  (cause as { readonly status: unknown }).status === 404;

const noneWhenGone = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => cause }).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      isNotFound(cause) ? Effect.succeed(Option.none<A>()) : Effect.fail(cause),
    ),
  );

// One pass is bounded by the replay's page budget; loop until the stream
// is drained, another run owns it, or the backfill has not run.
const MAX_PASSES = 50;

const drain = Effect.gen(function* () {
  const deps = {
    source: {
      listEvents: (options: Parameters<typeof workos.events.listEvents>[0]) =>
        fromPromise(async () => {
          const page = await workos.events.listEvents({
            ...options,
            events: [...options.events],
          });
          return { data: page.data, after: page.listMetadata.after ?? null };
        }),
      getOrganization: (organizationId: string) =>
        noneWhenGone(() => workos.organizations.getOrganization(organizationId)),
      getUser: (userId: string) => noneWhenGone(() => workos.userManagement.getUser(userId)),
    },
    store: {
      getOrganization: (organizationId: string) =>
        fromPromise(() => users.getOrganization(organizationId)),
      upsertOrganization: (organization: Parameters<typeof users.upsertOrganization>[0]) =>
        fromPromise(() => users.upsertOrganization(organization)),
      getAccount: (accountId: string) => fromPromise(() => users.getAccount(accountId)),
    },
    mirror: makeWorkOsMirrorStore(db),
  };
  let last: WorkOsEventsSyncReport | null = null;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const report = yield* replayWorkOsEvents(deps);
    console.log(
      `[drain-events] pass ${pass + 1}: ${report.pages} page(s), ${report.events} event(s), ` +
        `${report.applied} applied, ${report.stale} stale, ${report.absent} absent — ${report.stopped}`,
    );
    last = report;
    if (report.stopped !== "page_budget") break;
  }
  return last;
});

// A full server refuses the connection with SQLSTATE 53300 when it is opened.
// Open it first, waiting for a slot, rather than fail the deploy gate that
// spawned this run (src/db/too-many-connections.ts); the mirror store's own
// failures do not carry the driver code, so the wait cannot sit around the
// drain itself.
const connected = waitForConnectionSlot(sql, {
  onRefused: (_failure, attempt) =>
    console.log(`[drain-events] ${describeRefusedAttempt(attempt)}`),
});

const report = await Effect.runPromise(
  connected.pipe(
    Effect.andThen(drain),
    Effect.ensuring(Effect.promise(() => sql.end({ timeout: 5 }))),
  ),
);

if (report === null || report.stopped !== "drained") {
  console.error(
    `[drain-events] the events stream was not drained: ${report?.stopped ?? "no pass ran"}` +
      (report?.stopped === "awaiting_backfill"
        ? " (run scripts/backfill-workos-mirror.ts first)"
        : report?.stopped === "cursor_contended"
          ? " (another run owns the stream; rerun once it finishes)"
          : ""),
  );
  process.exit(1);
}
