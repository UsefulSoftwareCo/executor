/** Typed browser OAuth operations. Client secrets and callback URLs stay redacted in Atom state. */
import { Data, Effect, Schema, type Redacted } from "effect";
import { Atom } from "effect/unstable/reactivity";
import {
  AppId,
  AccountId,
  AccountConnectionId,
  type ProviderId,
  type OAuthClientInput,
} from "@executor-js/sdk";
import { DashboardClient, appAtom, toolsAtom } from "./api.ts";
import { accountCredentialsChanged } from "./accounts.ts";
import { invalidate } from "@executor-js/ui/contracts/mutations";

class OAuthSetupKey extends Data.Class<{
  readonly provider: ProviderId;
  readonly method: string;
}> {}
const setupQuery = Atom.family((key: OAuthSetupKey) =>
  DashboardClient.query("dashboard", "oauthSetup", { payload: key }).pipe(
    Atom.setIdleTTL("5 minutes"),
    Atom.refreshOnWindowFocus,
  ),
);
/** Share read-only client requirements across local forms without creating connection attempts. */
export const oauthSetupAtom = (key: { readonly provider: ProviderId; readonly method: string }) =>
  setupQuery(new OAuthSetupKey(key));

/** Resolve automatic or supplied client configuration, then navigate to provider consent. */
export const startOAuthAtom = DashboardClient.runtime.fn(
  (
    input: {
      payload: {
        provider: ProviderId;
        method: string;
        label: string;
        client?: OAuthClientInput;
      };
    },
    get,
  ) =>
    Effect.flatMap(DashboardClient, (client) => client.dashboard.startOAuth(input)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.status === "completed") accountCredentialsChanged(get, result.account);
        }),
      ),
    ),
);
/** Keep the entry callback alive while auth/inventory gates load. Never written to browser storage. */
export const oauthCallbackAtom = Atom.make<Redacted.Redacted<string> | undefined>(undefined).pipe(
  Atom.keepAlive,
);
/** Safe navigation intent; the server separately owns provider, owner and credential identity. */
const OAuthAppReturn = Schema.Struct({
  connection: AccountConnectionId,
  app: AppId,
  slot: Schema.NonEmptyString,
});
export const OAuthReturn = Schema.Union([
  OAuthAppReturn,
  Schema.Struct({ connection: AccountConnectionId, account: AccountId }),
  Schema.Struct({ connection: AccountConnectionId }),
]);
/** Finish once per document load, even if React remounts the page. */
export const completeOAuthAtom = DashboardClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const callbackUrl = get.once(oauthCallbackAtom);
      if (callbackUrl === undefined) return undefined;
      const client = yield* DashboardClient;
      const saved = sessionStorage.getItem("executor.oauth.return");
      const target =
        saved === null
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OAuthReturn))(saved);
      if (target === undefined) return undefined;
      const savedAccount = yield* client.dashboard.completeOAuth({
        payload: { connection: target.connection, callbackUrl },
      });
      accountCredentialsChanged(get, savedAccount);
      if (Schema.is(OAuthAppReturn)(target)) {
        invalidate(get, appAtom(target.app));
        get.refresh(toolsAtom(target.app));
      }
      return savedAccount;
    }),
  )
  .pipe(Atom.keepAlive);
