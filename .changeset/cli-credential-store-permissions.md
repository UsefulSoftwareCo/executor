---
"executor": patch
---

**The CLI's server-connection store is written owner-only, and two of its tests now actually run**

`~/.executor/server-connections.json` holds live credentials for a hosted server — a bearer token, or an OAuth access token together with its long-lived refresh token, rewritten on every silent refresh. It was created with no explicit mode, so the process umask applied and it landed world-readable (0644 by default). Any other account on the machine — or anything that copies a home directory, such as a backup or a container layer — could read a durable credential until the user ran `executor logout`.

It is now created `0600` with a follow-up `chmod`, matching what the local-server manifest already does for the sibling secret it keeps under `server-control/`. Both steps are needed: `mode` applies only on create, and the `chmod` covers rewriting a store that already exists with looser permissions — which is the common path here, since the file is rewritten on every token refresh.

Separately, two tests in `server-profile.test.ts` were written as `it("…", () => Effect.gen(…))`. An `Effect` is not a thenable, so Vitest treated each as passing without ever running its body — a deliberately falsified assertion still passed. They are now `it.effect` and execute for real. No production behaviour was wrong; the tests simply were not checking it.
