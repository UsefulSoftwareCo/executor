/**
 * App events: subscriptions, fan-out and signed webhook delivery. Products authorize; this module
 * stores, matches, signs and retries. Deliveries are at least once: a receiver deduplicates on the
 * event ID, which stays the same across retries.
 */
import { Clock, Data, Effect, Option, Redacted, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { DeclaredEvents } from "apps/contracts";
import {
  AppEventDefinition,
  EventAccessRevoked,
  EventArguments,
  EventNotVisible,
  EventCallbackFailed,
  EventDefinitionChanged,
  EventNotFound,
  EventSubscription,
  EventSubscriptionId,
  EventSubscriptionInvalid,
  EventsUnavailable,
  StoredEventId,
  defaultEventDeliveryLimits,
  type CallbackFailure,
  type EventOptions,
  type EventSubscriptionKey,
  type ExecutorEvents,
} from "../contracts/events.ts";
import { AccountId, AppId, ProfileId, StorageError } from "../contracts/shared.ts";
import { SelectedAccounts } from "../contracts/apps.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { BackgroundWork } from "../contracts/declarations.ts";
import { query, transaction, type Query } from "./database.ts";
import { Validator } from "@cfworker/json-schema";

/** The private part of a subscription: its secret, and the one it replaced while both sign. */
const SubscriptionSecrets = Schema.Struct({
  secret: Schema.String,
  previous: Schema.optionalKey(Schema.Struct({ secret: Schema.String, until: Schema.Number })),
});
/** The private part of an occurrence. */
const EventBody = Schema.Struct({
  data: Schema.Json,
  filters: Schema.Record(Schema.String, Schema.Json),
});

const encoder = new TextEncoder();

/** Another write changed the subscription while this one was computed; it starts again. */
class SubscriptionChanged extends Data.TaggedError("SubscriptionChanged") {}

/** Key order carries no meaning, so equal arguments always give the same identity. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(text))).pipe(Effect.map(hex));

/** The deterministic ID of a subscription key. */
export const subscriptionId = (key: EventSubscriptionKey) =>
  digest(canonical([key.principal, key.callbackUrl, key.name, key.arguments])).pipe(
    Effect.map((value) => EventSubscriptionId.make(`evs_${value.slice(0, 32)}`)),
  );

/** A Standard Webhooks secret is `whsec_` and the base64 of 24 to 64 random bytes. */
const secretKey = (secret: string) => {
  if (!secret.startsWith("whsec_")) return Option.none();
  const decoded = Base64.decode(secret.slice("whsec_".length));
  if (decoded._tag === "Failure") return Option.none();
  const bytes = decoded.success;
  return bytes.byteLength >= 24 && bytes.byteLength <= 64 ? Option.some(bytes) : Option.none();
};

/** `v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>`, per Standard Webhooks. */
const sign = (secret: string, id: string, timestamp: number, body: string) =>
  Effect.gen(function* () {
    const key = Option.getOrThrow(secretKey(secret));
    const imported = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        Uint8Array.from(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    );
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign("HMAC", imported, encoder.encode(`${id}.${timestamp}.${body}`)),
    );
    return `v1,${Base64.encode(new Uint8Array(signature))}`;
  });

/** Constant-time comparison of two strings' UTF-8 bytes. */
const sameText = (left: string, right: string) => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
};

const randomToken = () =>
  Base64.encode(crypto.getRandomValues(new Uint8Array(24)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/**
 * Arguments fit the event's filters: its own schema with every filter optional, so a subscriber
 * may name any of them and nothing else.
 */
const fitsFilters = (filters: Readonly<Record<string, unknown>>, args: EventArguments) => {
  const { required: _required, ...optional } = filters;
  return new Validator({ ...optional, additionalProperties: false }, "2020-12", false).validate(
    args,
  ).valid;
};

/** Whether an occurrence's filter values satisfy a subscription's arguments. */
const matches = (args: EventArguments, filters: Readonly<Record<string, unknown>>) =>
  Object.entries(args).every(
    ([key, value]) => Object.hasOwn(filters, key) && filters[key] === value,
  );

const failureOf = (status: number): CallbackFailure => (status >= 500 ? "http_5xx" : "http_4xx");

export const makeEvents = (input: {
  readonly db: Query;
  readonly credentials: Credentials;
  readonly options: EventOptions | undefined;
  readonly background: BackgroundWork | undefined;
}): ExecutorEvents => {
  const { db, credentials, options } = input;
  const limits = { ...defaultEventDeliveryLimits, ...options?.limits };
  const storage = <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError(() => new StorageError()));
  const now = Clock.currentTimeMillis;

  const declared = (app: AppId) =>
    Effect.gen(function* () {
      const row = yield* query(() => db.findFirst("apps", { where: (b) => b("id", "=", app) }));
      if (row === null || row.activeDeployment === null)
        return { owner: row?.owner, events: {} as DeclaredEvents };
      const deployment = yield* query(() =>
        db.findFirst("deployments", { where: (b) => b("id", "=", row.activeDeployment) }),
      );
      // Requirements of builds before events have no `events`; they declare none.
      const parsed = Schema.decodeUnknownOption(
        Schema.Struct({ events: Schema.optional(DeclaredEvents) }),
      )(deployment?.requirements);
      const events: DeclaredEvents = Option.match(parsed, {
        onNone: () => ({}),
        onSome: (value) => value.events ?? {},
      });
      return { owner: row.owner, events };
    });

  const readSubscription = (id: EventSubscriptionId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("eventSubscriptions", { where: (b) => b("id", "=", id) }),
      );
      if (row === null) return null;
      const metadata = yield* storage(Schema.decodeUnknownEffect(EventSubscription)(row));
      return { row, metadata };
    });

  const secretsOf = (id: EventSubscriptionId, encrypted: Uint8Array) =>
    credentials.decrypt(id, Redacted.make(encrypted)).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(SubscriptionSecrets)(Redacted.value(value)),
      ),
      Effect.mapError(() => new StorageError()),
    );

  /** Signed headers for one request. Both secrets sign while a rotation overlaps. */
  const headers = (
    subscription: EventSubscriptionId,
    secrets: typeof SubscriptionSecrets.Type,
    messageId: string,
    body: string,
    time: number,
  ) =>
    Effect.gen(function* () {
      const timestamp = Math.floor(time / 1000);
      const signatures = [yield* sign(secrets.secret, messageId, timestamp, body)];
      if (secrets.previous !== undefined && secrets.previous.until > time)
        signatures.push(yield* sign(secrets.previous.secret, messageId, timestamp, body));
      return {
        "content-type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signatures.join(" "),
        "x-mcp-subscription-id": subscription,
      };
    });

  /** Prove the receiver wants deliveries: it must echo a fresh, single-use challenge. */
  const verify = (id: EventSubscriptionId, url: string, secrets: typeof SubscriptionSecrets.Type) =>
    Effect.gen(function* () {
      if (options === undefined) return yield* new EventsUnavailable();
      const challenge = randomToken();
      const body = JSON.stringify({ type: "verification", challenge });
      const signed = yield* headers(
        id,
        secrets,
        `msg_verification_${crypto.randomUUID()}`,
        body,
        yield* now,
      );
      const response = yield* options.sender.send(
        { url, headers: signed, body },
        limits.requestTimeoutMs,
        { readBody: true },
      );
      if (response.status < 200 || response.status >= 300)
        return yield* new EventCallbackFailed({ reason: failureOf(response.status) });
      const echoed = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ challenge: Schema.String })),
      )(response.body);
      if (Option.isNone(echoed) || !sameText(echoed.value.challenge, challenge))
        return yield* new EventCallbackFailed({ reason: "challenge_failed" });
    });

  const validUrl = (value: string) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" ||
          (url.protocol === "http:" && options?.allowInsecureCallbacks === true)) &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  };

  const grantedTtl = (ttlMs: number | null | undefined) =>
    ttlMs === undefined
      ? limits.defaultTtlMs
      : ttlMs === null
        ? limits.maxTtlMs
        : Math.min(Math.max(ttlMs, limits.minTtlMs), limits.maxTtlMs);

  const attemptSubscribe = (request: Parameters<ExecutorEvents["subscribe"]>[0]) =>
    Effect.gen(function* () {
      if (options === undefined) return yield* new EventsUnavailable();
      const secret = Redacted.value(request.secret);
      if (Option.isNone(secretKey(secret)))
        return yield* new EventSubscriptionInvalid({
          field: "secret",
          message: "The secret must be whsec_ followed by the base64 of 24 to 64 bytes.",
        });
      if (!validUrl(request.key.callbackUrl))
        return yield* new EventSubscriptionInvalid({
          field: "callbackUrl",
          message: "The callback URL must be an absolute https URL without credentials.",
        });
      if (request.ttlMs !== undefined && request.ttlMs !== null && request.ttlMs <= 0)
        return yield* new EventSubscriptionInvalid({
          field: "ttlMs",
          message: "The lifetime must be a positive number of milliseconds, or null.",
        });
      const id = yield* subscriptionId(request.key);
      const existing = yield* readSubscription(id);
      // A saved subscription keeps the app and event it was created for, so its refreshes keep
      // working after the app's slug changes. Its event and arguments are checked against the
      // current declaration: a refresh is how a client learns that they no longer exist.
      const target = existing?.metadata ?? request.target;
      if (target === undefined) return yield* new EventNotFound({ kind: "event" });
      const app = target.app;
      const event = "event" in target ? target.event : request.target!.event;
      const { owner, events } = yield* declared(app);
      const definition =
        owner !== undefined && Object.hasOwn(events, event) ? events[event] : undefined;
      const fits =
        definition !== undefined && fitsFilters(definition.filters, request.key.arguments);
      if (existing !== null && !fits) {
        // Deliveries could never match it again; stop it so nothing waits on it.
        yield* stopWith(id, "changed");
        return yield* definition === undefined
          ? new EventNotFound({ kind: "event" })
          : new EventDefinitionChanged();
      }
      if (owner === undefined || definition === undefined)
        return yield* new EventNotFound({ kind: "event" });
      if (!fits)
        return yield* new EventSubscriptionInvalid({
          field: "arguments",
          message:
            "The arguments must be filters this event declares, each with a value its schema accepts.",
        });
      const time = yield* now;
      const current = existing === null ? undefined : yield* secretsOf(id, existing.row.encrypted);
      const active =
        existing?.metadata.status === "active" && existing.metadata.expiresAt.getTime() > time;
      const rotated = current !== undefined && current.secret !== secret;
      const secrets: typeof SubscriptionSecrets.Type = rotated
        ? { secret, previous: { secret: current.secret, until: time + limits.secretOverlapMs } }
        : current !== undefined && current.previous !== undefined && current.previous.until > time
          ? { secret, previous: current.previous }
          : { secret };
      // A callback this principal verified within the reuse window is not challenged again,
      // whichever of its subscriptions the challenge was for. Reuse keeps the challenge's time,
      // so the window never extends without a new challenge.
      const windowStart = new Date(time - limits.verificationReuseMs);
      const verifiedBefore =
        active && !rotated && existing.row.verifiedAt > windowStart
          ? existing.row.verifiedAt
          : (yield* query(() =>
              db.findFirst("eventSubscriptions", {
                where: (b) =>
                  b.and(
                    b("principal", "=", request.key.principal),
                    b("callbackUrl", "=", request.key.callbackUrl),
                    b("status", "=", "active"),
                    b("verifiedAt", ">", windowStart),
                  ),
                orderBy: ["verifiedAt", "desc"],
              }),
            ))?.verifiedAt;
      // A changed secret is always proven against the receiver before it signs anything.
      const reuse = verifiedBefore !== undefined && !rotated;
      if (!reuse) yield* verify(id, request.key.callbackUrl, secrets);
      const encrypted = yield* credentials.encrypt(
        id,
        Redacted.make(Schema.encodeSync(SubscriptionSecrets)(secrets)),
      );
      const expiresAt = new Date(time + grantedTtl(request.ttlMs));
      const values = {
        status: "active",
        stopped: null,
        subject: request.subject,
        expiresAt,
        verifiedAt: reuse ? verifiedBefore : new Date(time),
        encrypted,
      };
      const revision = crypto.randomUUID();
      // Write only over the row this attempt computed from. Another refresh or a concurrent
      // first subscribe that won makes this attempt start again from the row it left.
      yield* transaction(db, () =>
        existing === null
          ? query(() =>
              db.create("eventSubscriptions", {
                id,
                owner,
                app,
                event,
                name: request.key.name,
                arguments: request.key.arguments,
                callbackUrl: request.key.callbackUrl,
                principal: request.key.principal,
                createdAt: new Date(time),
                revision,
                ...values,
              }),
            )
          : query(() =>
              db.updateMany("eventSubscriptions", {
                where: (b) => b.and(b("id", "=", id), b("revision", "=", existing.row.revision)),
                set: { ...values, revision },
              }),
            ),
      ).pipe(
        Effect.catchTag("StorageError", (error) =>
          Effect.gen(function* () {
            // A concurrent first subscribe inserted the row; start again from it.
            if (existing === null && (yield* readSubscription(id)) !== null)
              return yield* new SubscriptionChanged();
            return yield* error;
          }),
        ),
      );
      const written = yield* readSubscription(id);
      if (written?.row.revision !== revision) return yield* new SubscriptionChanged();
      return { id, refreshBefore: expiresAt };
    });
  const subscribe: ExecutorEvents["subscribe"] = (request) =>
    attemptSubscribe(request).pipe(
      Effect.retry({ while: (error) => error instanceof SubscriptionChanged, times: 3 }),
      Effect.catchTag("SubscriptionChanged", () => Effect.fail(new StorageError())),
      Effect.withSpan("sdk.events.subscribe"),
    );

  /**
   * Whether every account an occurrence used is selected by one of these profiles of the
   * subscription's app. An occurrence that used no account is within any scope.
   */
  const withinProfiles = (
    subscription: EventSubscription,
    profiles: readonly ProfileId[],
    stored: unknown,
  ) =>
    Effect.gen(function* () {
      const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(AccountId))(stored).pipe(
        Effect.mapError(() => new StorageError()),
      );
      if (accounts.length === 0) return true;
      if (profiles.length === 0) return false;
      const rows = yield* query(() =>
        db.findMany("profiles", {
          where: (b) =>
            b.and(
              b("id", "in", [...profiles]),
              b("owner", "=", subscription.owner),
              b("app", "=", subscription.app),
            ),
        }),
      );
      const selected = new Set<string>();
      for (const row of rows) {
        // An unreadable selection grants nothing, so the occurrence stays hidden.
        const parsed = Schema.decodeUnknownOption(SelectedAccounts)(row.accounts);
        if (Option.isSome(parsed))
          for (const value of Object.values(parsed.value))
            for (const account of Array.isArray(value) ? value : [value]) selected.add(account);
      }
      return accounts.every((account) => selected.has(account));
    });

  const stopWith = (
    id: EventSubscriptionId,
    reason: "unsubscribed" | "revoked" | "expired" | "changed",
    /**
     * For a revocation found by a delivery attempt: the subscription revision it authorized and
     * the lease it holds. A stale verdict leaves a refreshed subscription, or a delivery another
     * runner took over, untouched.
     */
    guard?: {
      readonly revision: string;
      readonly delivery: { readonly id: string; readonly lease: string };
    },
  ) =>
    Effect.gen(function* () {
      const time = new Date(yield* now);
      yield* transaction(db, () =>
        Effect.gen(function* () {
          if (guard !== undefined) {
            // A conditional write locks the delivery row until this transaction commits, so no
            // runner can take the lease over between this check and the stop below.
            yield* query(() =>
              db.updateMany("eventDeliveries", {
                where: (b) =>
                  b.and(
                    b("id", "=", guard.delivery.id),
                    b("lease", "=", guard.delivery.lease),
                    b("status", "=", "pending"),
                  ),
                set: { lease: guard.delivery.lease },
              }),
            );
            const held = yield* query(() =>
              db.findFirst("eventDeliveries", { where: (b) => b("id", "=", guard.delivery.id) }),
            );
            if (held === null || held.lease !== guard.delivery.lease || held.status !== "pending")
              return;
          }
          yield* query(() =>
            db.updateMany("eventSubscriptions", {
              where: (b) =>
                b.and(
                  b("id", "=", id),
                  b("status", "=", "active"),
                  // Expiry stops only what is still lapsed: a refresh may have committed since.
                  reason === "expired" ? b("expiresAt", "<=", time) : true,
                  guard === undefined ? true : b("revision", "=", guard.revision),
                ),
              // A refresh computed from the active row then starts again from the stopped one.
              set: { status: "stopped", stopped: reason, revision: crypto.randomUUID() },
            }),
          );
          const current = yield* query(() =>
            db.findFirst("eventSubscriptions", { where: (b) => b("id", "=", id) }),
          );
          if (current === null || current.status !== "stopped" || current.stopped !== reason)
            return;
          yield* query(() =>
            db.updateMany("eventDeliveries", {
              where: (b) => b.and(b("subscription", "=", id), b("status", "=", "pending")),
              set: { status: "dropped", finishedAt: time },
            }),
          );
        }),
      );
    });

  const find: ExecutorEvents["find"] = (key) =>
    subscriptionId(key).pipe(
      Effect.flatMap(readSubscription),
      Effect.map((found) => found?.metadata ?? null),
    );

  const record: ExecutorEvents["record"] = ({ app, accounts, events }) =>
    Effect.gen(function* () {
      if (events.length === 0) return;
      const time = yield* now;
      const subscriptions = yield* query(() =>
        db.findMany("eventSubscriptions", {
          where: (b) =>
            b.and(
              b("app", "=", app),
              b("status", "=", "active"),
              b("expiresAt", ">", new Date(time)),
              b("event", "in", [...new Set(events.map((occurrence) => occurrence.name))]),
            ),
        }),
      );
      // Encrypt first: no I/O to an outside service happens inside the transaction.
      const prepared = yield* Effect.forEach(events, (occurrence) =>
        Effect.gen(function* () {
          const id = StoredEventId.make(`evr_${crypto.randomUUID()}`);
          const encrypted = yield* credentials.encrypt(
            id,
            Redacted.make({ data: occurrence.data, filters: occurrence.filters }),
          );
          const matching = subscriptions.filter(
            (row) =>
              row.event === occurrence.name &&
              Option.match(Schema.decodeUnknownOption(EventArguments)(row.arguments), {
                onNone: () => false,
                onSome: (args) => matches(args, occurrence.filters),
              }),
          );
          return { id, encrypted, occurrence, matching };
        }),
      );
      // One invocation's events are saved together or not at all.
      const queued = yield* transaction(db, () =>
        Effect.gen(function* () {
          let queued = false;
          for (const { id, encrypted, occurrence, matching } of prepared) {
            // A repeated upstream delivery carries the same event ID; it was recorded already.
            const seen = yield* query(() =>
              db.findFirst("events", {
                where: (b) =>
                  b.and(
                    b("app", "=", app),
                    b("name", "=", occurrence.name),
                    b("eventId", "=", occurrence.id),
                  ),
              }),
            );
            if (seen !== null) continue;
            yield* query(() =>
              db.create("events", {
                id,
                app,
                name: occurrence.name,
                eventId: occurrence.id,
                account: occurrence.account,
                accounts: [...accounts],
                occurredAt: new Date(occurrence.occurredAt),
                encrypted,
                createdAt: new Date(time),
              }),
            );
            for (const subscription of matching) {
              queued = true;
              yield* query(() =>
                db.create("eventDeliveries", {
                  id: `${subscription.id}/${id}`,
                  subscription: subscription.id,
                  event: id,
                  status: "pending",
                  attempts: 0,
                  nextAt: new Date(time),
                  lease: null,
                  leaseUntil: new Date(0),
                  lastError: null,
                  createdAt: new Date(time),
                  finishedAt: null,
                }),
              );
            }
          }
          return queued;
        }),
      );
      // Deliver at once instead of waiting for the next wake. A failure leaves them due.
      if (queued && input.background !== undefined)
        yield* input.background(
          deliver({ maxDeliveries: 16 }).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.logWarning("Immediate event delivery failed")),
          ),
        );
    }).pipe(Effect.withSpan("sdk.events.record", { attributes: { "executor.app.id": app } }));

  /** Claim one due delivery for this attempt; another runner's claim wins. */
  const claim = (id: string) =>
    Effect.gen(function* () {
      const lease = crypto.randomUUID();
      const time = yield* now;
      yield* query(() =>
        db.updateMany("eventDeliveries", {
          where: (b) =>
            b.and(
              b("id", "=", id),
              b("status", "=", "pending"),
              // Another pass may have attempted it since it was selected and set its next try.
              b("nextAt", "<=", new Date(time)),
              b("leaseUntil", "<=", new Date(time)),
            ),
          set: { lease, leaseUntil: new Date(time + limits.leaseMs) },
        }),
      );
      const row = yield* query(() =>
        db.findFirst("eventDeliveries", { where: (b) => b("id", "=", id) }),
      );
      return row !== null && row.lease === lease ? { ...row, lease } : null;
    });

  /** Settle a claimed delivery. An attempt whose lease another runner took writes nothing. */
  const finish = (
    delivery: { readonly id: string; readonly lease: string },
    set: {
      readonly status: "pending" | "delivered" | "failed" | "dropped";
      readonly attempts?: number;
      readonly nextAt?: Date;
      readonly lastError?: string | null;
    },
    time: number,
  ) =>
    query(() =>
      db.updateMany("eventDeliveries", {
        where: (b) =>
          b.and(
            b("id", "=", delivery.id),
            b("lease", "=", delivery.lease),
            b("status", "=", "pending"),
          ),
        set: {
          ...set,
          lease: null,
          leaseUntil: new Date(0),
          ...(set.status === "pending" ? {} : { finishedAt: new Date(time) }),
        },
      }),
    );

  const attempt = (delivery: {
    readonly id: string;
    readonly lease: string;
    readonly subscription: string;
    readonly event: string;
    readonly attempts: number;
  }) =>
    Effect.gen(function* () {
      const time = yield* now;
      const id = EventSubscriptionId.make(delivery.subscription);
      const found = yield* readSubscription(id);
      const occurrence = yield* query(() =>
        db.findFirst("events", { where: (b) => b("id", "=", delivery.event) }),
      );
      if (
        found === null ||
        occurrence === null ||
        found.metadata.status !== "active" ||
        found.metadata.expiresAt.getTime() <= time
      )
        return yield* finish(delivery, { status: "dropped" }, time);
      // An event past its maximum age is abandoned, not sent late.
      if (occurrence.createdAt.getTime() < time - limits.retentionMs)
        return yield* finish(delivery, { status: "dropped", lastError: "expired" }, time);
      // Backoff counts from when the failure is seen, after any wait for the receiver.
      const retry = (reason: string) =>
        Effect.gen(function* () {
          const failedAt = yield* now;
          const attempts = delivery.attempts + 1;
          return yield* attempts >= limits.maxAttempts
            ? finish(delivery, { status: "failed", attempts, lastError: reason }, failedAt)
            : finish(
                delivery,
                {
                  status: "pending",
                  attempts,
                  lastError: reason,
                  nextAt: new Date(
                    failedAt +
                      Math.min(limits.firstBackoffMs * 2 ** (attempts - 1), limits.maxBackoffMs),
                  ),
                },
                failedAt,
              );
        });
      const authorized = yield* options!
        .authorize({
          subscription: found.metadata,
          account: occurrence.account,
          // Unreadable account lists fail closed: the delivery is retried, never sent unchecked.
          accounts: yield* Schema.decodeUnknownEffect(Schema.Array(AccountId))(
            occurrence.accounts,
          ).pipe(Effect.mapError(() => new StorageError())),
        })
        .pipe(
          Effect.flatMap((scope) =>
            scope?.profiles === undefined
              ? Effect.succeed("allowed" as const)
              : withinProfiles(found.metadata, scope.profiles, occurrence.accounts).pipe(
                  Effect.map((within) => (within ? ("allowed" as const) : ("hidden" as const))),
                ),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              Schema.is(EventAccessRevoked)(error)
                ? ("revoked" as const)
                : Schema.is(EventNotVisible)(error)
                  ? ("hidden" as const)
                  : ("unavailable" as const),
            ),
          ),
        );
      if (authorized === "revoked")
        return yield* stopWith(id, "revoked", { revision: found.row.revision, delivery });
      if (authorized === "hidden")
        return yield* finish(delivery, { status: "dropped", lastError: "not_visible" }, time);
      if (authorized === "unavailable") return yield* retry("authorization");
      const body = yield* credentials
        .decrypt(StoredEventId.make(occurrence.id), Redacted.make(occurrence.encrypted))
        .pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(EventBody)(Redacted.value(value))),
          Effect.mapError(() => new StorageError()),
        );
      const text = JSON.stringify({
        eventId: occurrence.eventId,
        name: found.metadata.name,
        timestamp: occurrence.occurredAt.toISOString(),
        data: body.data,
        cursor: null,
      });
      if (encoder.encode(text).byteLength > limits.maxBodyBytes)
        return yield* finish(delivery, { status: "failed", lastError: "too_large" }, time);
      const secrets = yield* secretsOf(id, found.row.encrypted);
      const signed = yield* headers(id, secrets, occurrence.eventId, text, time);
      const response = yield* options!.sender
        .send(
          { url: found.metadata.callbackUrl, headers: signed, body: text },
          limits.requestTimeoutMs,
          { readBody: false },
        )
        .pipe(Effect.result);
      if (response._tag === "Failure") return yield* retry(response.failure.reason);
      const status = response.success.status;
      if (status >= 200 && status < 300)
        return yield* finish(
          delivery,
          { status: "delivered", attempts: delivery.attempts + 1, lastError: null },
          time,
        );
      // The receiver refused this delivery for good; the subscription itself continues.
      if (status === 410 || status === 413)
        return yield* finish(
          delivery,
          { status: "failed", attempts: delivery.attempts + 1, lastError: `http_${status}` },
          time,
        );
      return yield* retry(failureOf(status));
    }).pipe(Effect.withSpan("sdk.events.attempt"));

  /**
   * Retention. An event lives for `retentionMs`: after that it is deleted, and a delivery of it
   * still pending, which only an outage longer than every retry can leave, is abandoned. Finished
   * deliveries go after the same time. Each step is one indexed statement, whatever the backlog.
   */
  const cleanup = (time: number) =>
    Effect.gen(function* () {
      const cutoff = new Date(time - limits.retentionMs);
      yield* query(() =>
        db.updateMany("eventDeliveries", {
          where: (b) => b.and(b("status", "=", "pending"), b("createdAt", "<", cutoff)),
          set: {
            status: "dropped",
            lastError: "expired",
            lease: null,
            leaseUntil: new Date(0),
            finishedAt: new Date(time),
          },
        }),
      );
      yield* query(() =>
        db.deleteMany("eventDeliveries", {
          where: (b) => b.and(b("status", "!=", "pending"), b("finishedAt", "<", cutoff)),
        }),
      );
      yield* query(() => db.deleteMany("events", { where: (b) => b("createdAt", "<", cutoff) }));
    });

  const deliver: ExecutorEvents["deliver"] = ({ maxDeliveries }) =>
    Effect.gen(function* () {
      if (options === undefined) return false;
      const time = yield* now;
      // Lapsed subscriptions stop, and their pending deliveries with them.
      const lapsed = yield* query(() =>
        db.findMany("eventSubscriptions", {
          where: (b) => b.and(b("status", "=", "active"), b("expiresAt", "<=", new Date(time))),
          limit: 100,
        }),
      );
      for (const row of lapsed) yield* stopWith(EventSubscriptionId.make(row.id), "expired");
      const due = yield* query(() =>
        db.findMany("eventDeliveries", {
          where: (b) =>
            b.and(
              b("status", "=", "pending"),
              b("nextAt", "<=", new Date(time)),
              b("leaseUntil", "<=", new Date(time)),
            ),
          orderBy: ["nextAt", "asc"],
          limit: maxDeliveries,
        }),
      );
      yield* Effect.forEach(
        due,
        (row) =>
          claim(row.id).pipe(
            Effect.flatMap((claimed) => (claimed === null ? Effect.void : attempt(claimed))),
            Effect.catch(() => Effect.logWarning("Event delivery attempt failed")),
          ),
        { concurrency: 8, discard: true },
      );
      // Retention never blocks delivery: it runs after, and its own failure is only logged.
      yield* cleanup(time).pipe(
        Effect.catch(() => Effect.logWarning("Event retention cleanup failed")),
      );
      return due.length === maxDeliveries;
    }).pipe(Effect.withSpan("sdk.events.deliver"));

  return {
    definitions: ({ app }) =>
      declared(app).pipe(
        Effect.flatMap(({ events }) =>
          storage(
            Schema.decodeUnknownEffect(Schema.Array(AppEventDefinition))(
              Object.entries(events).map(([name, event]) => ({ app, name, ...event })),
            ),
          ),
        ),
      ),
    subscribe,
    unsubscribe: (key) =>
      subscriptionId(key).pipe(Effect.flatMap((id) => stopWith(id, "unsubscribed"))),
    find,
    list: ({ app }) =>
      query(() =>
        db.findMany("eventSubscriptions", {
          where: (b) => b("app", "=", app),
          orderBy: ["createdAt", "desc"],
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          storage(Schema.decodeUnknownEffect(Schema.Array(EventSubscription))(rows)),
        ),
      ),
    stop: ({ id, reason }) => stopWith(id, reason),
    record,
    deliver,
    nextWake: query(() =>
      db.findFirst("eventDeliveries", {
        where: (b) => b("status", "=", "pending"),
        orderBy: ["nextAt", "asc"],
      }),
    ).pipe(Effect.map((row) => (row === null ? null : row.nextAt))),
  };
};
