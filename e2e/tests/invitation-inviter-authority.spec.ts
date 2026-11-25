import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { resentStaleInvitation, staleInvitations } from "../support/invitation-authority.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Invitation inviter authority", (it) => {
  it.effect(scenarios.invitationInviterAuthority.title, (context) =>
    withHostedCase(
      context,
      staleInvitations((statements) =>
        legacyStorage(statements).pipe(Effect.tap(() => serverControl("start"))),
      ),
    ),
  );
  it.effect(scenarios.invitationInviterResend.title, (context) =>
    withHostedCase(
      context,
      resentStaleInvitation((statements) =>
        legacyStorage(statements).pipe(Effect.tap(() => serverControl("start"))),
      ),
    ),
  );
});
