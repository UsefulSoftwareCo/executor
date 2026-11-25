import { layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { writeRows } from "../support/cloud-rows.ts";
import { resentStaleInvitation, staleInvitations } from "../support/invitation-authority.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud invitation inviter authority", (it) => {
  it.effect(scenarios.cloudInvitationInviterAuthority.title, (context) =>
    withHostedCase(
      context,
      staleInvitations((statements) => writeRows("sso-database.json", statements)),
    ),
  );
  it.effect(scenarios.cloudInvitationInviterResend.title, (context) =>
    withHostedCase(
      context,
      resentStaleInvitation((statements) => writeRows("sso-database.json", statements)),
    ),
  );
});
