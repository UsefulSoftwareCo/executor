# Child process input descriptors

`@effect%2Fplatform-node-shared@4.0.1.patch` keeps an `error` listener on
each extra input descriptor (`additionalFds` with `type: "input"`) for the
child's lifetime.

Node opens every extra descriptor as a duplex socket and reads from it, even
one the parent only writes to. On Linux these are Unix socket pairs: a child
that exits, or is killed, without reading all of its input resets the socket,
and the parent's read fails with `ECONNRESET`. The release's sink listens for
`error` only while it writes, so that later error has no listener and becomes
an uncaught exception. In the desktop's Electron main process this opened a
native error dialog and stopped the app whenever a backend exited before
reading its fd3 bootstrap, for example after a refused key setup.

Errors during a write still reach the sink and fail it. An error after the
write has finished carries nothing to act on; the child's exit is observed
through its exit code. Output descriptors already keep a listener for their
whole lifetime.

The patch changes both source and distributed JavaScript. Regenerate it with
`bun patch` when upgrading, and remove the patch once upstream keeps
an input descriptor's listener.
