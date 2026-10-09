/** Typed browser OAuth operations. Client secrets and callback URLs stay redacted in Atom state. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Data, Effect, Option, Schema, type Redacted } from "effect";
import { Atom } from "effect/reactivity";
import { AppId, ProfileId, type ProviderId } from "@executor-js/sdk";
import { DashboardClient, appAtom, toolsAtom } from "./api.ts";
import { accountCredentialsChanged } from "./accounts.ts";
import { profileSelectionChanged } from "./profiles.ts";
import { invalidate } from "@executor-js/ui/contracts/mutations";

class OAuthSetupKey extends Data.Class<{
  readonly provider: ProviderId;
  readonly method: string;
}> {}
const setupQuery = Atom.family((key: OAuthSetupKey) =>
  DashboardClient.query("dashboard", "oauthSetup", hydrated({ payload: key })).pipe(
    Atom.setIdleTTL("5 minutes"),
    revalidated,
  ),
);
/** Share read-only client requirements across local forms without creating connection attempts. */
export const oauthSetupAtom = (key: { readonly provider: ProviderId; readonly method: string }) =>
  setupQuery(new OAuthSetupKey(key));

/** Keep the entry callback alive while auth/inventory gates load. Never written to browser storage. */
export const oauthCallbackAtom = Atom.make<Redacted.Redacted<string> | undefined>(undefined).pipe(
  Atom.keepAlive,
);
/** Safe navigation intent; the server finds the connection from the callback's OAuth state. */
/**
 * Every sign-in fills an app requirement, which completion selects, so it returns to that app's
 * accounts. A reconnect keeps the account's name.
 */
export const OAuthReturn = Schema.Struct({
  app: AppId,
  profile: ProfileId,
  reconnect: Schema.Boolean,
});
/** Finish once per document load, even if React remounts the page. */
export const completeOAuthAtom = DashboardClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const callbackUrl = get.once(oauthCallbackAtom);
      if (callbackUrl === undefined) return undefined;
      const client = yield* DashboardClient;
      // A provider link opened in another tab has no saved return; it still completes.
      const target = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthReturn))(
        sessionStorage.getItem("executor.oauth.return"),
      );
      const savedAccount = yield* client.dashboard.completeOAuth({ payload: { callbackUrl } });
      accountCredentialsChanged(get, savedAccount);
      if (Option.isSome(target)) {
        invalidate(get, appAtom(target.value.app));
        get.refresh(toolsAtom({ app: target.value.app }));
        profileSelectionChanged(get, target.value.app);
      }
      return savedAccount;
    }),
  )
  .pipe(Atom.keepAlive);
