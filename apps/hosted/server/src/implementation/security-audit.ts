/**
 * Emit `security.audit` log records. A record joins its request's trace, and copies what the
 * request's span knows about the client and its credential, so it can be read on its own.
 */
import { currentRequestSpan } from "@executor-js/telemetry/http";
import type { AccountId, AppId } from "@executor-js/sdk/core";
import { Cause, Context, Effect, Exit, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { CurrentUserId } from "../contracts/auth.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import type { SecurityAuditAction, SecurityAuditEvent } from "../contracts/security-audit.ts";

/**
 * Server span attributes every record repeats: the client's network and the credential, including
 * the admin who impersonates the session's user.
 */
const copied = [
  "auth.failure.reason",
  "geo.country.iso_code",
  "cloudflare.asn",
  "cloudflare.as_organization",
  "auth.credential.kind",
  "auth.credential.id",
  "auth.impersonated_by",
] as const;

/** Record one audited action. It never fails and reads nothing but the request's own context. */
export const recordSecurityAudit = (event: SecurityAuditEvent) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const request = Context.getOption(context, HttpServerRequest.HttpServerRequest);
    const organization =
      event.organization ??
      Option.getOrUndefined(
        Option.map(
          Context.getOption(context, CurrentOrganization),
          (current) => current.organization,
        ),
      );
    const user = event.user ?? Context.get(context, CurrentUserId);
    const span = yield* currentRequestSpan;
    const annotations: Record<string, string | number> = {
      "audit.action": event.action,
      "audit.outcome": event.outcome,
    };
    if (event.target !== undefined) {
      annotations["audit.target.kind"] = event.target.kind;
      if (event.target.id !== undefined) annotations["audit.target.id"] = event.target.id;
    }
    if (event.failure !== undefined) annotations["audit.failure"] = event.failure;
    for (const [key, value] of Object.entries(event.detail ?? {}))
      annotations[`audit.${key}`] = value;
    if (user !== undefined) annotations["executor.user.id"] = user;
    if (organization !== undefined) annotations["executor.organization.id"] = organization;
    const address = Option.flatMap(request, (request) => request.remoteAddress);
    if (Option.isSome(address)) annotations["client.address"] = address.value;
    if (Option.isSome(span))
      for (const key of copied) {
        const value = span.value.attributes.get(key);
        if (typeof value === "string" || typeof value === "number") annotations[key] = value;
      }
    yield* Effect.logInfo("security.audit").pipe(Effect.annotateLogs(annotations));
  });

/**
 * Telemetry is best effort. Keep a bounded, per-process/isolate set of recently reported link
 * states, not a permission cache. Repeated calls for one refusal do not each emit a record.
 * The database supplies the link and creator membership revision; a later demotion is new even
 * if nobody tried to use the link while the creator was promoted.
 */
const reportedAppLinkRefusals = new Map<string, string>();
export const recordAppLinkCreatorRefusal = (link: {
  readonly app: AppId;
  readonly id: AccountId;
  readonly requirement: string;
  readonly creatorRefusal: string;
}) =>
  Effect.suspend(() => {
    const key = JSON.stringify([link.app, link.requirement, link.id]);
    const previous = reportedAppLinkRefusals.get(key);
    reportedAppLinkRefusals.delete(key);
    reportedAppLinkRefusals.set(key, link.creatorRefusal);
    if (previous === link.creatorRefusal) return Effect.void;
    if (reportedAppLinkRefusals.size > 4096) {
      const oldest = reportedAppLinkRefusals.keys().next().value;
      if (oldest !== undefined) reportedAppLinkRefusals.delete(oldest);
    }
    return recordSecurityAudit({
      action: "app_account.use_refused",
      outcome: "failure",
      target: { kind: "account", id: link.id },
      detail: {
        app: link.app,
        requirement: link.requirement,
        reason: "creator_not_admin_or_owner",
      },
    });
  });

/**
 * Record an action a product handler performs, with its outcome. A refusal carries the request's
 * `auth.failure.reason` when a check recorded one. A request that ends before the action does is
 * `interrupted`: a change it started may still be stored. Only a completed action names its target,
 * by `target.id` of its result, a record the action found authorized or stored; what the request
 * asked for can be any text. `succeeded` adds detail read from a completed action's result. A
 * `detail` function is read once the action ends, so it can name what the action resolved before
 * it was refused, never what the request named.
 */
export const audited =
  <A>(
    action: SecurityAuditAction,
    target: { readonly kind: string; readonly id: (value: A) => string | undefined },
    detail?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>),
    succeeded?: (value: A) => Readonly<Record<string, string>>,
  ) =>
  <E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.onExit(effect, (exit) => {
      const ended = typeof detail === "function" ? detail() : detail;
      return recordSecurityAudit({
        action,
        outcome: Exit.isSuccess(exit)
          ? "success"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failure",
        target: { kind: target.kind, id: Exit.isSuccess(exit) ? target.id(exit.value) : undefined },
        detail:
          Exit.isSuccess(exit) && succeeded !== undefined
            ? { ...ended, ...succeeded(exit.value) }
            : ended,
      });
    });

/**
 * The records hooks inside a storage transaction made, which a request that starts the transaction
 * collects and records once it returns, so after the transaction committed.
 */
export class CommittedAudits extends Context.Service<
  CommittedAudits,
  { readonly pending: SecurityAuditEvent[] }
>()("hosted/CommittedAudits") {}

/**
 * Record `event` once the transaction it describes commits: held for the request that collects
 * {@link CommittedAudits}, or recorded now where no request does.
 */
export const recordSecurityAuditOnCommit = (event: SecurityAuditEvent) =>
  Effect.flatMap(
    Effect.serviceOption(CommittedAudits),
    Option.match({
      onNone: () => recordSecurityAudit(event),
      onSome: (audits) =>
        Effect.sync(() => {
          audits.pending.push(event);
        }),
    }),
  );

/**
 * Run `effect`, which commits its transactions before it returns, collecting the records its hooks
 * made; record them once it succeeds. A failed or interrupted run rolled back what they describe.
 */
export const withCommittedAudits = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const audits = { pending: [] as SecurityAuditEvent[] };
    return effect.pipe(
      Effect.provideService(CommittedAudits, audits),
      Effect.tap(() => Effect.forEach(audits.pending, recordSecurityAudit, { discard: true })),
    );
  });
