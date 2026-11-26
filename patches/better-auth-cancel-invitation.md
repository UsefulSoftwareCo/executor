# Better Auth organization: cancel only pending invitations

`better-auth@1.7.20.patch` changes `cancelInvitation` in
`dist/plugins/organization/routes/crud-invites.mjs`.

Better Auth wrote `canceled` over any invitation, including one already
accepted, rejected or canceled, and answered 200. An administrator who
cancelled an invitation the recipient had just accepted was told it was
cancelled while the recipient stayed a member.

With the patch, cancelling passes `fromStatus: "pending"` to
`updateInvitation`, as acceptance already does, so the status changes in the
same statement that checks it. An invitation that was accepted is answered
with `INVITATION_ALREADY_ACCEPTED` (400), so the dashboard can say the person
has joined; any other invitation that is no longer pending is answered with
`INVITATION_NOT_FOUND` (400), as acceptance and rejection answer it.
`invitation-reaccept.spec.ts` cancels an accepted invitation and checks the
refusal and the membership, and `invitation-dialog.spec.ts` checks what the
revoke dialog then says.

Drop this hunk when Executor upgrades to a Better Auth release that checks the
status when cancelling.
