import { useAtomValue } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { LoadingAnnouncement, UnknownPagePending } from "@executor-js/hosted-web/page-pending";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";

export function SelfHostLoginPending() {
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  if (session) return <UnknownPagePending fullScreen />;
  return (
    <div className="min-h-dvh">
      <LoadingAnnouncement>Loading sign-in…</LoadingAnnouncement>
    </div>
  );
}
