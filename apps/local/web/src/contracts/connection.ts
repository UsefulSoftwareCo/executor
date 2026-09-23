import { DashboardRuntime } from "./telemetry.ts";
/** Local auth state uses the same HTTP contracts as the server. Credentials never enter storage. */
import { LocalAuthApi, type BootstrapToken } from "@executor-js/local-server/auth";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";

/** Browser cookie authentication is automatic on same-origin requests. */
export class AuthClient extends AtomHttpApi.Service<AuthClient>()("AuthClient", {
  api: LocalAuthApi,
  runtime: DashboardRuntime,
  transformClient: (client) =>
    client.pipe(HttpClient.transformResponse(Effect.withSpan("ui.auth"))),
  httpClient: FetchHttpClient.layer,
}) {}

/** Receives pairing links at startup and when an existing tab gets a new fragment. */
export const pairingTokenAtom = Atom.make<typeof BootstrapToken.Type | undefined>(undefined).pipe(
  Atom.keepAlive,
);
/** Session checks expose only authenticated status, never the HttpOnly credential. */
export const sessionAtom = AuthClient.query("auth", "session", {}).pipe(Atom.refreshOnWindowFocus);
/** Exchange each received link before mounting authenticated reads. */
export const bootstrapAtom = AuthClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const token = get(pairingTokenAtom);
      if (token !== undefined) {
        const client = yield* AuthClient;
        yield* client.auth.exchange({ payload: { token } });
        get.refresh(sessionAtom);
      }
    }),
  )
  .pipe(Atom.keepAlive);
