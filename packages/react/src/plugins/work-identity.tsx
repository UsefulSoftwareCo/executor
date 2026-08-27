import { useCallback } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  WorkIdentityStatusSchema,
  type OAuthClientSlug,
  type Owner,
  type WorkIdentityStatus,
} from "@executor-js/sdk/shared";

import { startWorkIdentityLink, workIdentityLinkCompleted } from "../api/atoms";
import { workIdentityWriteKeys } from "../api/reactivity-keys";
import { oauthCallbackUrl, useOAuthPopupFlow, type OAuthPopupReservation } from "./oauth-sign-in";

// ---------------------------------------------------------------------------
// Linking a work identity from the browser.
//
// This is the leg the console could not previously walk. An enterprise-managed
// connect presents an identity assertion, and no browser can obtain one — the
// identity provider's client secret is server-side. So the browser does the one
// thing only it can: it carries the member through a real OIDC sign-in at the
// organization's identity provider. Executor builds the authorization URL,
// redeems the code with the IdP app's own credentials, and takes custody of the
// durable subject.
//
// It reuses `useOAuthPopupFlow` rather than growing a second popup stack. That
// hook already owns the three things that are easy to get wrong and invisible
// when they are: the window reserved on the click (user activation expires
// while `start` is in flight), settle-exactly-once across postMessage /
// BroadcastChannel / localStorage, and teardown on unmount — which is what makes
// closing the modal mid-link genuinely abandon it.
//
// The link's redirect lands on the SHARED `/api/oauth/callback`, which decides
// from the stored session which flow it is completing and posts
// `{ workIdentity }` back. That key is the discriminator, and it is PARSED here:
// a connection payload is spread flat and shares field names with nothing that
// could be mistaken for a status.
// ---------------------------------------------------------------------------

/** The popup payload a completed link posts back to the opener. */
export interface WorkIdentityPopupPayload {
  readonly workIdentity: WorkIdentityStatus;
}

const decodeLinkPayload = Schema.decodeUnknownOption(
  Schema.Struct({ workIdentity: WorkIdentityStatusSchema }),
);

/** The linked identity carried by a popup completion, or null when the message
 *  was some other flow's. Parsed, never cast: this value crosses a postMessage
 *  boundary and decides what the console says the member is signed in as. */
export const workIdentityFromPopupPayload = (payload: unknown): WorkIdentityStatus | null =>
  Option.match(decodeLinkPayload(payload), {
    onNone: () => null,
    onSome: (decoded) => decoded.workIdentity,
  });

/** Which held identity a link is about — the IdP registration, and the owner
 *  the connections backed by it are made under. */
export interface WorkIdentityRefInput {
  readonly owner: Owner;
  readonly idpClient: OAuthClientSlug;
  readonly idpClientOwner: Owner;
}

export interface StartWorkIdentityLinkInput {
  readonly ref: WorkIdentityRefInput;
  /** Window reserved on the click that began this flow. Required in practice:
   *  a link is always reached after at least one round trip (the connect that
   *  reported `workIdentityLinkRequired`, or a health verdict), by which time
   *  the browser has forgotten the click. */
  readonly reservation?: OAuthPopupReservation;
  /** The account that was linked. Runs after the reactivity bump, so anything
   *  it triggers already reads the linked state. */
  readonly onLinked: (identity: WorkIdentityStatus) => void | Promise<void>;
  readonly onError?: (message: string) => void;
}

/** The "who am I signed in as" line, or null when nothing is held.
 *
 *  `needs_relink` deliberately does NOT read as linked: an identity the provider
 *  has rejected still names an account, and showing it plainly would tell the
 *  member everything is fine while every connection behind it is stalled. */
export const workIdentityLinkedLabel = (identity: WorkIdentityStatus): string | null => {
  if (identity.status === "unlinked") return null;
  const who = identity.label ?? identity.subject ?? "your work identity";
  return identity.status === "linked" ? `linked as ${who}` : `${who} · sign in again`;
};

/**
 * Drive a work-identity link through the shared OAuth popup machinery.
 *
 * Every piece of in-flight state lives in the returned handle, which lives in
 * the component that called this hook — so a modal that unmounts takes the
 * dangling session, the popup window, and the busy flag with it.
 */
export function useWorkIdentityLink(options: { readonly popupName: string }) {
  const doStartLink = useAtomSet(startWorkIdentityLink, {
    mode: "promiseExit",
  });
  const doLinkCompleted = useAtomSet(workIdentityLinkCompleted, {
    mode: "promiseExit",
  });
  const popup = useOAuthPopupFlow<WorkIdentityPopupPayload>({
    popupName: options.popupName,
    // A work identity link crosses the identity provider's own consent and MFA
    // screens, where COOP can make a live popup read as closed. Cancelling is
    // the explicit path; a false "you closed it" mid-MFA is not.
    detectPopupClosed: false,
    startErrorMessage: "Couldn't start the work identity sign-in",
    popupBlockedMessage: "Your browser blocked the work identity sign-in window",
  });

  const link = useCallback(
    async (input: StartWorkIdentityLinkInput): Promise<void> => {
      await popup.openAuthorization({
        owner: input.ref.owner,
        ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
        reportMetadata: {
          idp_client: String(input.ref.idpClient),
          owner: input.ref.owner,
        },
        run: () =>
          doStartLink({
            payload: {
              owner: input.ref.owner,
              idpClient: input.ref.idpClient,
              idpClientOwner: input.ref.idpClientOwner,
              // The same callback every interactive connect uses, so an
              // enterprise registers ONE redirect URI and not two.
              redirectUri: oauthCallbackUrl(),
            },
            // Starting a link changes nothing until the callback completes it.
            reactivityKeys: [],
          }).then((exit) => {
            if (Exit.isSuccess(exit)) {
              return {
                state: String(exit.value.state),
                authorizationUrl: exit.value.authorizationUrl,
              };
            }
            // Reject with the server's own typed failure, cause and all, so
            // `WorkIdentityLinkError.message` reaches the user verbatim rather
            // than as a generic "sign-in failed".
            return Effect.runPromise(Effect.failCause(exit.cause));
          }),
        onSuccess: async (payload: WorkIdentityPopupPayload) => {
          const identity = workIdentityFromPopupPayload(payload);
          if (identity === null) {
            // The callback answered, but not with a work identity. Refusing to
            // guess is the point: retrying the connect on a link that did not
            // happen would fail again with the same unhelpful message.
            input.onError?.("The sign-in did not return a work identity. Try linking again.");
            return;
          }
          await doLinkCompleted({ reactivityKeys: workIdentityWriteKeys });
          await input.onLinked(identity);
        },
        ...(input.onError === undefined
          ? {}
          : { onError: (message: string) => input.onError?.(message) }),
      });
    },
    [doLinkCompleted, doStartLink, popup],
  );

  return {
    /** True while the sign-in window is open or the start is in flight. */
    busy: popup.busy,
    error: popup.error,
    link,
    /** Claim the sign-in window on the click, before any await. */
    reserve: popup.reserve,
    /** Close a claimed window this flow turned out not to need. */
    releaseReservation: popup.releaseReservation,
    cancel: popup.cancel,
    setError: popup.setError,
  };
}
