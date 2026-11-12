# Better Auth Generic OAuth: UserInfo claims

`better-auth@1.7.20.patch` changes `fetchUserInfo` in
`dist/plugins/generic-oauth/index.mjs`. Self-host SSO uses this default fetch.

An ID token that has `sub` and `email` used to be taken as the whole profile,
and UserInfo was not requested. OIDC Core 1.0 §5.4 lets the authorization code
flow return scope claims only from UserInfo. Okta's org authorization server
does this: its ID token leaves out `email_verified`. Better Auth then created
the user with an unverified email, and self-host registration refused it
([UsefulSoftwareCo/executor#2307](https://github.com/UsefulSoftwareCo/executor/issues/2307)).

With the patch, a verified ID token that leaves out `email_verified` causes a
UserInfo request. Its claims are used only when its `sub` matches the ID
token's (§5.3.2). Claims in the ID token take precedence, and a UserInfo `id`
never replaces the token's subject.

The same change, with unit tests, is on
[RhysSullivan/better-auth-core@fix/generic-oauth-userinfo-email-verified](https://github.com/RhysSullivan/better-auth-core/tree/fix/generic-oauth-userinfo-email-verified).
Drop this hunk when Executor upgrades to a Better Auth release that includes it.
