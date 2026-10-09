/**
 * One-off data step: redeploy Executor apps still built on an `apps` release before
 * `0.0.1-beta.10` on this host's release, changing nothing but the pin.
 *
 * Releases up to beta.9 refreshed cached values in the background with the invocation's `fetch`,
 * which aborts when the invocation ends, so dynamic catalogs such as the Executor app's skills only
 * refreshed when the cache entry expired. Beta.10 fixed it, but a deployment keeps the framework
 * it was built with, and Executor never upgrades an app on its own.
 */
import { Schema } from "effect";

/** The journal name. It never changes and the step never repeats. */
export const executorAppRedeployStepName = "5_redeploy_pre_beta10_executor_apps";

/** The first release with the fix. Apps pinned to an exact earlier release are redeployed. */
export const executorAppRedeployFixedRelease = "0.0.1-beta.10";

/**
 * Items are apps whose only account slot is a provider named `Executor`, the shape of every
 * Executor app a host generates. Outcomes:
 * - `redeploy` (report) / `redeployed` (apply): the running source pins an exact release before
 *   beta.10 and `main` holds that source, or that source with the new pin. The running files are
 *   deployed with only `dependencies.apps` changed, and `main` gets the same files.
 * - `redeploy-behind` / `redeployed-behind`: the same, but `main` holds exactly the source of an
 *   earlier deployment that the running one replaced, as a direct file deploy leaves it. `main`
 *   gets the running source with the new pin; its previous files stay in its history.
 * - `redeploy-pinned` / `redeployed-pinned`: the same, but `main` holds the running source under a
 *   framework pin that `1_app_framework_pin` or `2_app_framework_pin_catch_up` committed before
 *   member setup deployed the host's template over it without writing Git. Only `package.json`
 *   differs: `dependencies.apps` is the release those steps write, and `name` may be missing from
 *   `main`. `main` gets the running source with the new pin.
 * - `redeploy-behind-pinned` / `redeployed-behind-pinned`: the same, but `main` holds the source of
 *   an earlier deployment that the running one replaced, under the same framework pin. Those steps
 *   commit the then-running source with the pin when `main` was behind it, and member setup later
 *   deployed a newer template without writing Git. `package.json` may differ only as for
 *   `redeploy-pinned`. `main` gets the running source with the new pin; the pin commit stays in its
 *   history.
 * - `current`: the running source pins beta.10 or later.
 * - `other-pin`: the running source declares no exact `apps` release, or its manifest is not JSON.
 * - `edited`: `main` holds other work. Left alone.
 * - `undeployed`: nothing runs. Left alone.
 * - `build-failed`: the running source does not build on this host's release, so nothing changed.
 *   Not retried: it fails the same way every time.
 * - `conflict`: the app was deployed or its `main` changed while it was handled. Retried.
 * - `failed`: storage, Git or the build service failed for this app; other apps continue. Retried.
 * - `removed`: the app was deleted before it could be handled.
 */
export const ExecutorAppRedeployOutcome = Schema.Literals([
  "redeploy",
  "redeploy-behind",
  "redeploy-pinned",
  "redeploy-behind-pinned",
  "redeployed",
  "redeployed-behind",
  "redeployed-pinned",
  "redeployed-behind-pinned",
  "current",
  "other-pin",
  "edited",
  "undeployed",
  "build-failed",
  "conflict",
  "failed",
  "removed",
]);
export type ExecutorAppRedeployOutcome = typeof ExecutorAppRedeployOutcome.Type;

/** The commit that records the redeployed source on `main`. */
export const executorAppRedeployMessage = (from: string, to: string) =>
  `Update the apps framework from ${from} to ${to}\n\nExecutor redeployed this app on a framework release that refreshes cached values in the background. No other file changed.`;
