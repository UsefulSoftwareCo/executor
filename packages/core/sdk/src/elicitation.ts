import { Effect, Schema } from "effect";

import { ElicitationId, ToolAddress } from "./ids";

/* A tool that needs user input mid-call suspends and the host's `onElicitation`
 * handler (executor-level, overridable per `execute`) answers. Tools that never
 * elicit never trigger it. Schema-tagged so requests/responses cross the wire. */

/** Implementation-defined context an upstream attached to the request.
 *
 *  Opaque and never interpreted here — it is carried so a host can SHOW the
 *  terms of an approval it would otherwise hide. The case that forced it: a
 *  Codex plugin's per-site browser approval sends an empty `requestedSchema`
 *  and puts `persist: "always"` and the `origin` in its metadata, so
 *  accepting grants a permanent allow for that site. Without this the user is
 *  asked to consent to strictly more than the prompt tells them. */
export const ElicitationMeta = Schema.Record(Schema.String, Schema.Unknown);
export type ElicitationMeta = typeof ElicitationMeta.Type;

/** The persistence scopes an approval OFFERS, when its terms leave that to
 *  the answer. Codex Computer Use sends `persist: ["session", "always"]` and
 *  remembers the app only if the reply names one; a bare accept is a
 *  one-time approval and the very next call asks again. Chrome's per-site
 *  approval sends `persist: "always"` — a statement of what accepting
 *  means, not a choice — and contributes nothing here. */
export const offeredPersistence = (meta: ElicitationMeta | undefined): readonly string[] => {
  const persist = meta?.["persist"];
  return Array.isArray(persist) && persist.every((scope) => typeof scope === "string")
    ? persist
    : [];
};

/** What an accepted approval carries back, in the request's own vocabulary.
 *
 *  Closed on purpose, the mirror of the request-side projection: an answer
 *  can only state terms this contract names, so no host can grant something
 *  the prompt never offered. `persist` is the one term that is a choice —
 *  one of `offeredPersistence(request.meta)`, or absent for a one-time
 *  approval. */
export const ElicitationResponseMeta = Schema.Struct({
  persist: Schema.optional(Schema.String),
});
export type ElicitationResponseMeta = typeof ElicitationResponseMeta.Type;

/** Tool needs structured input from the user (render a form). */
export const FormElicitation = Schema.TaggedStruct("FormElicitation", {
  message: Schema.String,
  /** JSON Schema describing the fields to collect. */
  requestedSchema: Schema.Record(Schema.String, Schema.Unknown),
  meta: Schema.optional(ElicitationMeta),
});
export type FormElicitation = typeof FormElicitation.Type;

/** Tool needs the user to visit a URL (OAuth, approval page, etc.). */
export const UrlElicitation = Schema.TaggedStruct("UrlElicitation", {
  message: Schema.String,
  url: Schema.String,
  /** Unique id so the host can correlate the callback. */
  elicitationId: ElicitationId,
  meta: Schema.optional(ElicitationMeta),
});
export type UrlElicitation = typeof UrlElicitation.Type;

export type ElicitationRequest = FormElicitation | UrlElicitation;

export const ElicitationAction = Schema.Literals(["accept", "decline", "cancel"]);
export type ElicitationAction = typeof ElicitationAction.Type;

export const ElicitationResponse = Schema.Struct({
  action: ElicitationAction,
  /** Present when `action` is "accept" — the data the user provided. */
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** The answer's own terms, meaningful only with "accept". */
  meta: Schema.optional(ElicitationResponseMeta),
});
export type ElicitationResponse = typeof ElicitationResponse.Type;

/** Handler input — the tool address being invoked, its args, and the request. */
export interface ElicitationContext {
  readonly address: ToolAddress;
  readonly args: unknown;
  readonly request: ElicitationRequest;
}

/** Host-provided handler the SDK calls when a tool suspends for input. */
export type ElicitationHandler = (ctx: ElicitationContext) => Effect.Effect<ElicitationResponse>;

/** Executor-level elicitation policy: a handler, or `"accept-all"` to
 *  auto-accept every request (tests / non-interactive hosts). */
export type OnElicitation = ElicitationHandler | "accept-all";

/** Per-call options for `execute`. */
export interface InvokeOptions {
  /** Override the executor-level handler for this single call. */
  readonly onElicitation?: OnElicitation;
}

/** A tool was declined or cancelled during elicitation. */
export class ElicitationDeclinedError extends Schema.TaggedErrorClass<ElicitationDeclinedError>()(
  "ElicitationDeclinedError",
  {
    address: ToolAddress,
    action: Schema.Literals(["decline", "cancel"]),
  },
) {
  // Derived message so telemetry (span status, logs) labels the failure
  // instead of rendering an Error with an empty message.
  override get message(): string {
    return `Tool approval ${this.action === "cancel" ? "cancelled" : "declined"}: ${this.address}`;
  }
}
