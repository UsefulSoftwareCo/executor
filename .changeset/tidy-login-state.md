---
"@executor-js/cloud": patch
---

fix: make login CSRF state mandatory in the WorkOS callback

The callback previously skipped its CSRF check whenever the redirect carried
no `state` value ("some WorkOS-initiated redirects don't include one"). That
bypass let an attacker complete their own OAuth round-trip and redirect a
victim's browser through the callback with the attacker's `code` and no
`state`, silently signing the victim into the attacker's account (login CSRF).

The check is now unconditional: a callback without a state matching the
`wos-login-state` cookie set on `/login` is rejected with 400. This is a
breaking change for any client relying on the undocumented no-state entry
path; server-initiated flows that cannot carry state must be redesigned with
a signed nonce instead of re-adding the bypass.
