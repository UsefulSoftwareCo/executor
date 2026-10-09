import { useAtomValue } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { LoadingAnnouncement, UnknownPagePending } from "@executor-js/hosted-web/page-pending";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";

/**
 * Sign-in while its page loads. A sign-in document arrives as the form itself, so this shows only
 * where the browser opens sign-in, as when a session ends in the running dashboard, or where the
 * server could not read the sign-in settings in time. The form's size depends on those settings
 * (first-run setup, SSO), and the card is centred, so a card drawn before they arrive would move.
 * The screen stays blank instead, announced as loading.
 *
 * The server knows the session before it renders, and a signed-in visit continues into the
 * product, so it shows no sign-in at all.
 */
export function SelfHostLoginPending() {
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  if (session) return <UnknownPagePending fullScreen />;
  return (
    <div className="min-h-dvh">
      <LoadingAnnouncement>Loading sign-in…</LoadingAnnouncement>
    </div>
  );
}
