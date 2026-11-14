/**
 * Emit `security.audit` log records. A record joins its request's trace, and copies what the
 * request's span knows about the client and its credential, so it can be read on its own.
 */
import { currentRequestSpan } from "@executor-js/telemetry/http";
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
 * Record an action a product handler performs, with its outcome. A refusal carries the request's
 * `auth.failure.reason` when a check recorded one. A request that ends before the action does is
 * `interrupted`: a change it started may still be stored. Only a completed action names its target,
 * by `target.id` of its result, a record the action found authorized or stored; what the request
 * asked for can be any text.
 */
export const audited =
  <A>(
    action: SecurityAuditAction,
    target: { readonly kind: string; readonly id: (value: A) => string | undefined },
    detail?: Readonly<Record<string, string>>,
  ) =>
  <E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.onExit(effect, (exit) =>
      recordSecurityAudit({
        action,
        outcome: Exit.isSuccess(exit)
          ? "success"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failure",
        target: { kind: target.kind, id: Exit.isSuccess(exit) ? target.id(exit.value) : undefined },
        detail,
      }),
    );
