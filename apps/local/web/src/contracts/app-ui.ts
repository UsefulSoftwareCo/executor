import { AppAuthenticationApi } from "@executor-js/local-server/app-ui";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

/** Dashboard identity authorizes a browser-bound attempt that began at an app URL. */
export class AppAuthenticationClient extends AtomHttpApi.Service<AppAuthenticationClient>()(
  "AppAuthenticationClient",
  {
    api: AppAuthenticationApi,
    httpClient: FetchHttpClient.layer,
  },
) {}
/** Exchange the current Executor login for an app-scoped callback. */
export const authorizeAppAtom = AppAuthenticationClient.mutation("appAuthentication", "authorize");
