---
"apps": patch
---

`apps/ui/serving` exports `appFile`, which answers a version's own file, or a 404 for a missing
dotted path, and returns `None` for the page itself, so hosts can serve files before page work.
`appDocument` renders only the document and inlines the version watcher; `appWatchScript` is
removed, along with the hosts' `/_executor/watch.js` routes.
