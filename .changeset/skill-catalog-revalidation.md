---
"apps": patch
---

`githubSkills` and `wellKnownSkills` with `cache: ctx.cache` no longer serve a
catalog past `freshFor` while it refreshes. A read first checks the source with
one request, the ref's commit or the well-known index, and loads the files again
only when the publication changed. A check that fails or takes over five seconds
fails the read. `ctx.cache.get` accepts `stale: "revalidate"` for the same
behavior on other entries.
