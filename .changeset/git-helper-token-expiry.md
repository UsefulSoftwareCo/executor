---
"@executor-js/app-management": patch
"@executor-js/app-source": patch
"@executor-js/app-templates": patch
"@executor-js/hosted-server": patch
---

`executor apps credential` returns the access token's refresh point as
`password_expiry_utc`. Git stores a helper's credential in every other helper it
has, such as the macOS keychain, and sends that copy first; once the token had
expired, the next push failed with `Authentication failed`. Git 2.41 and later
now drop the kept copy when the CLI would refresh it. The documented clone
command clears other helpers for the clone and keeps the CLI's helper configured
for later pushes.

Hosted Git returns 401 only when the caller's credential is refused. A session
check that cannot run, or a repository token Artifacts still refuses after a
refresh, fails as a retryable error, and a push whose forwarding fails reports
its refs as rejected with a message to push again.
