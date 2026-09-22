/** Pending tool calls are encrypted; consumption clears their payload before external work. */
import type { ApprovalElicitation, ApprovalResponse } from "apps/contracts";
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import {
  defaultToolApprovalLimits,
  ToolApprovalNotFound,
  ToolInvocation,
  type ToolResumeResult,
} from "../contracts/tools.ts";
import {
  ApprovalRequestId,
  CredentialsError,
  Json,
  JsonObject,
  OwnerId,
  RequestInvalid,
  StorageError,
} from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";

const Payload = Schema.Struct({
  invocation: ToolInvocation.pipe(
    Schema.encodeKeys({
      profile: "installation",
      profileRevision: "installationRevision",
    }),
  ),
  originalInput: Json,
});
const Record = Schema.Struct({
  id: ApprovalRequestId,
  owner: OwnerId,
  status: Schema.Literals(["pending", "consumed"]),
  revision: Schema.String,
  encrypted: Schema.RedactedFromValue(Schema.Uint8Array),
  expiresAt: Schema.Date,
});

/** Consume-once storage. The caller supplies authority; no decision or tool result is retained. */
export function makeToolApprovals(
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  inTransaction: Effect.Effect<boolean>,
) {
  const next = crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
  const read = (requestId: ApprovalRequestId, owner?: OwnerId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("toolApprovals", { where: (b) => b("id", "=", requestId) }),
      );
      if (row === null || (owner !== undefined && row.owner !== owner))
        return yield* new ToolApprovalNotFound({ requestId });
      return yield* Schema.decodeUnknownEffect(Record)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    });
  const prune = (owner?: OwnerId, pendingRequest?: ApprovalRequestId) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      yield* query(() =>
        db.deleteMany("toolApprovals", {
          where: (b) =>
            b.and(
              b("expiresAt", "<=", now),
              owner === undefined ? true : b("owner", "=", owner),
              // Let this resume report expiry for its pending request. Expired consumed markers are absent.
              pendingRequest === undefined
                ? true
                : b.or(b("id", "!=", pendingRequest), b("status", "=", "consumed")),
            ),
        }),
      );
    });
  return {
    prune,
    get: (requestId: ApprovalRequestId, owner?: OwnerId) =>
      Effect.gen(function* () {
        const row = yield* read(requestId, owner);
        if (row.status !== "pending" || row.expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
          return yield* new ToolApprovalNotFound({ requestId });
        const payload = yield* credentials.decrypt(row.id, row.encrypted).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(Payload)(Redacted.value(value))),
          Effect.mapError(() => new StorageError()),
        );
        return { invocation: payload.invocation, expiresAt: row.expiresAt.getTime() };
      }),
    save: (invocation: ToolInvocation, originalInput: Json, elicitation: ApprovalElicitation) =>
      Effect.gen(function* () {
        yield* prune(invocation.owner);
        const id = ApprovalRequestId.make(`apr_${yield* next}`);
        yield* Effect.annotateCurrentSpan("executor.approval.id", id);
        const expiresAt = new Date(
          (yield* Clock.currentTimeMillis) + defaultToolApprovalLimits.ttlMs,
        );
        const payload = yield* Schema.encodeEffect(Payload)({ invocation, originalInput }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
          Effect.mapError(() => new StorageError()),
        );
        const encrypted = yield* credentials.encrypt(id, Redacted.make(payload));
        const revision = yield* next;
        yield* query(() =>
          db.create("toolApprovals", {
            id,
            owner: invocation.owner,
            status: "pending",
            revision,
            encrypted,
            expiresAt,
          }),
        );
        return {
          status: "approval-required" as const,
          requestId: id,
          invocation,
          elicitation,
          expiresAt: expiresAt.getTime(),
        };
      }),
    resume: (
      input: {
        requestId: ApprovalRequestId;
        response: ApprovalResponse;
        owner?: OwnerId | undefined;
      },
      execute: (
        invocation: ToolInvocation,
        originalInput: Json,
      ) => Effect.Effect<ToolResumeResult, StorageError | CredentialsError>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("executor.approval.id", input.requestId);
        if (yield* inTransaction) return yield* new RequestInvalid();
        yield* prune(input.owner, input.requestId);
        const claim = yield* next;
        const consumed = yield* transaction(db, () =>
          Effect.gen(function* () {
            const original = yield* read(input.requestId, input.owner);
            if (original.status === "consumed") return { kind: "consumed" as const };
            if (original.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
              yield* query(() =>
                db.deleteMany("toolApprovals", {
                  where: (b) =>
                    b.and(
                      b("id", "=", original.id),
                      b("status", "=", "pending"),
                      b("revision", "=", original.revision),
                    ),
                }),
              );
              return { kind: "expired" as const };
            }
            // Claim and clear atomically. Only the winning transaction retains the prior ciphertext in memory.
            yield* query(() =>
              db.updateMany("toolApprovals", {
                where: (b) =>
                  b.and(
                    b("id", "=", original.id),
                    b("status", "=", "pending"),
                    b("revision", "=", original.revision),
                  ),
                set: { status: "consumed", revision: claim, encrypted: new Uint8Array() },
              }),
            );
            const current = yield* read(original.id, input.owner);
            return current.revision === claim
              ? { kind: "claimed" as const, original }
              : { kind: "consumed" as const };
          }),
        );
        if (consumed.kind === "consumed")
          return { status: "already-consumed" as const, requestId: input.requestId };
        if (consumed.kind === "expired")
          return {
            status: "failed" as const,
            requestId: input.requestId,
            reason: "expired" as const,
          };
        if (input.response.action === "decline")
          return { status: "denied" as const, requestId: input.requestId };
        if (input.response.action === "cancel")
          return { status: "cancelled" as const, requestId: input.requestId };
        const payload = yield* credentials
          .decrypt(consumed.original.id, consumed.original.encrypted)
          .pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(Payload)(Redacted.value(value)).pipe(
                Effect.mapError(() => new StorageError()),
              ),
            ),
          );
        // The consume commits before dispatch. A crash, interruption or lost response never makes it retryable.
        return yield* execute(payload.invocation, payload.originalInput);
      }),
  };
}
