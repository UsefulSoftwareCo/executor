import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OAuthStartError } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Blocked by administrator — reading an enterprise policy denial as STRUCTURE.
//
// When an enterprise identity provider refuses to mint an ID-JAG, the failure
// is an administrator's decision, not a credential problem. `OAuthStartError`
// says so in a typed field (`blockedByAdmin`) precisely so a console never has
// to read the sentence: matching on message text would silently start passing
// or failing whenever the wording changed, and the consequence of getting it
// wrong is offering the interactive per-server flow — which would route the
// user straight around the control the enterprise just exercised.
//
// So: this module decodes the field, and NOTHING here inspects `message`
// except to display it.
// ---------------------------------------------------------------------------

/** An enterprise identity provider declined this connect under administrator
 *  policy. Terminal by construction: there is no retry and no alternative
 *  route to offer, only the decision and a code support can trace. */
export interface OAuthAdminBlock {
  /** The failure's own message, shown verbatim. */
  readonly message: string;
  /** The identity provider's RFC 6749 §5.2 code (`unauthorized_client`,
   *  `invalid_target`, …), when it returned one. Null otherwise. */
  readonly oauthErrorCode: string | null;
}

const decodeStartError = Schema.decodeUnknownOption(OAuthStartError);

/** One level of wrapping: the popup flow wraps a start failure in its own
 *  tagged error before it reaches a renderer, and the verdict must survive
 *  that hop. Exactly one level — a `cause` chain is not a search space. */
const decodeWrapped = Schema.decodeUnknownOption(Schema.Struct({ cause: Schema.Unknown }));

const directAdminBlock = (error: unknown): OAuthAdminBlock | null =>
  Option.match(decodeStartError(error), {
    onNone: () => null,
    onSome: (start) =>
      start.blockedByAdmin === true
        ? { message: start.message, oauthErrorCode: start.oauthErrorCode ?? null }
        : null,
  });

/** The administrator verdict carried by a failed `oauth.start`, or null when
 *  the failure is anything else — including every other OAuth start failure,
 *  which leaves the interactive route open. */
export const adminBlockFrom = (error: unknown): OAuthAdminBlock | null =>
  directAdminBlock(error) ??
  Option.match(decodeWrapped(error), {
    onNone: () => null,
    onSome: (wrapper) => directAdminBlock(wrapper.cause),
  });

/** `adminBlockFrom` over an `Exit`, for the mutation call sites that hold one. */
export const adminBlockFromExit = (exit: Exit.Exit<unknown, unknown>): OAuthAdminBlock | null =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => null,
    onSome: adminBlockFrom,
  });

/** What the user is told. Sentence case per the design system's voice rules:
 *  what happened, then what to do next — and the next step is a person, not a
 *  button, because no action in this console can change the verdict. */
export const ADMIN_BLOCK_TITLE = "Blocked by your organization";
export const ADMIN_BLOCK_NEXT_STEP =
  "Ask an administrator to allow this server at your identity provider.";

/** The support-traceable reference line, or null when the provider returned no
 *  code. Mono metadata, per the design system. */
export const adminBlockReference = (block: OAuthAdminBlock): string | null =>
  block.oauthErrorCode === null ? null : `Reference: ${block.oauthErrorCode}`;
