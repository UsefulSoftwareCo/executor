---
"apps": minor
"@executor-js/sdk": minor
"@executor-js/hosted-server": minor
"@executor-js/hosted-web": patch
"@executor-js/hosted-cloud": patch
"@executor-js/ui": patch
---

App authors can opt app-scope account collections into member contributions with
`provider.many().contributed()`. Members who can use the app may connect or link
accounts they can use. Each contribution records its linker; that person or an
app editor may unlink it, including through saved-account deletion. Ordinary
requirements keep their existing permissions.

Link views report `linkedBy` and `canRemove`; requirement views report
`canContribute`. The Accounts tab names contributors and offers only permitted
removals. Account checks hide upstream identity from viewers who are neither
the holder, an account manager nor an app editor. Ordinary app links still show
identity only to app editors. Human-entered labels and descriptions are preserved.

Organization departures durably unlink personal contributions through the
existing link and webhook-source paths. The additive outbox uses existing
member jobs and recovers old-server acknowledgements under new job IDs.
Retained protocol-13 bundles keep running; contributed declarations use host
protocol 14.
