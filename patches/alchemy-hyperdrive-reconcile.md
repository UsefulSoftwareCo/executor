# Alchemy Hyperdrive reconcile patch

alchemy 2.0.0-beta.79's and beta.80's `Cloudflare.Hyperdrive.Connection` call `updateConfig` whenever the
resource is planned as an update ([alchemy-run/alchemy#1807](https://github.com/alchemy-run/alchemy/issues/1807)).
Cloud's origin depends on the migration job's output, so every deploy plans one. Each update
opens a new origin pool and leaves the old one open until it idles out.

The patch (in `alchemy@2.0.0-beta.80.patch`, both `src` and `lib`) returns without an update
when the request built from the new props, password included, equals the one built from the
previous props, and the live config's origin host, port, database, user and scheme, caching,
mTLS and origin limit match. The password is write-only in Cloudflare's API; the previous props
already hold it in Alchemy state, so nothing new is stored. Any difference falls through to the
existing update, so drift in readable fields is still corrected. A password changed outside
Alchemy is not.

Verified on beta.79 with `test-perf-hdgo-0925`: an unchanged second deploy planned the update, reconciled in
246 ms and left the config's `modified_on` at its creation time. Remove the patch when the pinned
alchemy includes an equivalent fix.
