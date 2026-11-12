# Playwright: keep Chromium's request interception on

When a page's last route goes away, Playwright 1.63's Chromium network manager
sends `Fetch.disable`. A route goes away when `unroute` or `unrouteAll` removes
it, or when a `{ times: n }` route has answered its last request. A request the
page starts in the few milliseconds before Chromium processes the disable can be
lost. The dashboard does exactly this: its tool runner reads the approval as
soon as a run's answer arrives. The request is never sent and never fails, so
the page waits forever. `tool-runner-approvals.spec.ts` failed this way in CI
once, with the runner left on its spinner.

Logging the DevTools traffic shows three ways a request is lost. Chromium
numbers its interception jobs in order, and a stuck request's job number is
missing from the log:

1. The request is reported (`Network.requestWillBeSent`) after Playwright
   marked interception off, and its `Fetch.requestPaused` arrives afterwards.
   Playwright stores the pause and nothing continues it.
2. The pause arrives first and is stored, then the report arrives after
   interception was marked off. Playwright records the request without the
   pause, and again nothing continues it.
3. Chromium creates the interception job but drops its `Fetch.requestPaused`
   when the disable lands, and never resumes the request. Playwright never
   learns the job's ID, so no Playwright-side fix can continue it.

Upstream's fix, [microsoft/playwright#43627](https://github.com/microsoft/playwright/pull/43627)
for [#43619](https://github.com/microsoft/playwright/issues/43619), is in
Playwright 1.65.0 and covers only the first. With it alone, a standalone
reproduction still lost a read in about 1 round in 100 (3 of 300, against 5 of
300 unpatched). Handling the second as well made no measurable difference
(12 of 600), because the third is the common one.

`playwright-core@1.63.0.patch` therefore never sends `Fetch.disable`. Once a
route enables the Fetch domain on a page, it stays enabled. A request no route
handles is continued at once, as Playwright already does for HTTP credentials.
The cache rule is unchanged: Playwright turns the HTTP cache off while any route
is registered and back on when the last one goes. The patch also carries
upstream's change, which still matters when a route is first registered while a
request is in flight. The one cost is that, after a page's first route, each
request it sends makes a round trip to Playwright while paused, as it already
did while a route was registered. The edit is in `lib/coreBundle.js`, the built
file 1.63.0 publishes. Upstream's source is
`packages/playwright-core/src/server/chromium/crNetworkManager.ts`.

`playwright-routes.spec.ts` (`bun run e2e:playwright-routes`, in CI's `tooling`
job) runs real Playwright and Chromium against a local server. It checks a
`{ times: 1 }` route that expires, and a route its handler `unroute`s, while the
page sends four reads on the answer; each case runs 3,000 rounds. It also checks
that the HTTP cache is off only while a route is registered. Unpatched, a read
was lost within 18 rounds in every run (18 losses in 127 rounds).

Drop this patch when the repository moves to a Playwright release that never
leaves a request paused when its last route goes away. 1.65.0 is not that
release: it has only upstream's change, and the third case above is in
Chromium. Run `playwright-routes.spec.ts` against the new version without the
patch to decide.
