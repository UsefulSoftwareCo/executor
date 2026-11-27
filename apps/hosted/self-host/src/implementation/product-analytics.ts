import { ProductAnalytics } from "@executor-js/hosted-server";
import type { ScheduleObservation } from "@executor-js/sdk/scheduling";
import {
  analyticsDestination,
  analyticsNotice,
  makeAnalyticsSender,
  platformToken,
  releaseChannelOf,
  RootDomain,
} from "@executor-js/telemetry/product-analytics";
import { Config, Console, Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SqlClient, type SqlError } from "effect/sql";
import { parse } from "tldts";

const sharedHostDomains = new Set([
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
  "ngrok.io",
  "ngrok.app",
  "ngrok.dev",
  "ngrok-free.app",
  "ngrok-free.dev",
  "trycloudflare.com",
  "duckdns.org",
  "ts.net",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "localhost.run",
  "lhr.life",
  "tunnelmole.net",
  "ddns.net",
  "no-ip.org",
  "no-ip.com",
  "hopto.org",
  "zapto.org",
  "sytes.net",
  "dynu.net",
  "freeddns.org",
  "mooo.com",
  "afraid.org",
]);

export const rootDomain = (origin: string) => {
  const hostname = URL.parse(origin)?.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === undefined || hostname.startsWith("[")) return "private";
  const parsed = parse(hostname, { allowPrivateDomains: true });
  if (
    parsed.isIp === true ||
    parsed.isIcann !== true ||
    parsed.domain === null ||
    parsed.publicSuffix === null ||
    parsed.publicSuffix.split(".").at(-1) === "arpa" ||
    sharedHostDomains.has(parsed.domain)
  )
    return "private";
  return Schema.is(RootDomain)(parsed.domain) ? parsed.domain : "private";
};

const Count = Schema.Struct({ count: Schema.Union([Schema.Number, Schema.NumberFromString]) });
const count = (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
  rows.pipe(
    Effect.flatMap((result) => Schema.decodeUnknownEffect(Count)(result[0])),
    Effect.map(({ count }) => count),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );

export const selfHostAnalytics = Effect.gen(function* () {
  const destination = yield* analyticsDestination;
  if (destination === undefined) return undefined;
  const install = yield* Config.String("EXECUTOR_INSTALL_ID");
  const secret = yield* Config.Redacted("EXECUTOR_ANALYTICS_SECRET");
  const origin = yield* Config.String("BETTER_AUTH_URL");
  const version = yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(
    Config.withDefault("development"),
  );
  const os = yield* Config.String("EXECUTOR_HOST_OS").pipe(Config.withDefault("unknown"));
  const arch = yield* Config.String("EXECUTOR_HOST_ARCH").pipe(Config.withDefault("unknown"));
  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  const sender = yield* makeAnalyticsSender({
    destination,
    common: { install_id: install, product: "self-host", version, root_domain: rootDomain(origin) },
    distinctId: (user) =>
      Effect.promise(() => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(user))).pipe(
        Effect.map((signature) => Hex.encode(new Uint8Array(signature))),
      ),
  });
  yield* Console.log(analyticsNotice);
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.gen(function* () {
    const [apps, accounts, users, organizations] = yield* Effect.all([
      count(sql`select count(*) as count from executor_apps`),
      count(sql`select count(*) as count from executor_accounts`),
      count(sql`select count(*) as count from "user"`),
      count(sql`select count(*) as count from organization`),
    ]);
    sender.capture("instance_started", {
      product: "self-host",
      version,
      channel: releaseChannelOf(version),
      os: platformToken(os),
      arch: platformToken(arch),
      ...(apps === undefined ? {} : { apps }),
      ...(accounts === undefined ? {} : { accounts }),
      ...(users === undefined ? {} : { users }),
      ...(organizations === undefined ? {} : { organizations }),
    });
  }).pipe(Effect.forkScoped);
  const product: typeof ProductAnalytics.Service = {
    enabled: true,
    capture: (event) =>
      sender.capture(
        event.event,
        {
          ...event.context,
          ...event.properties,
          ...(event.properties.method === undefined ? {} : { auth_kind: event.properties.method }),
        },
        event.userId,
      ),
    submitFeedback: (feedback) =>
      sender.submit("feedback_submitted", { message: feedback.message }, feedback.userId),
  };
  const schedules: typeof ScheduleObservation.Service = {
    completed: (run) =>
      Effect.sync(() =>
        sender.capture("schedule_run_completed", {
          source: "schedule",
          outcome:
            run.status === "succeeded"
              ? "success"
              : run.status === "cancelled"
                ? "cancelled"
                : "failure",
          ok: run.status === "succeeded",
          duration_ms:
            run.finishedAt === null
              ? 0
              : Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime()),
        }),
      ),
  };
  return { product, schedules };
}).pipe(Effect.catch(() => Effect.succeed(undefined)));
