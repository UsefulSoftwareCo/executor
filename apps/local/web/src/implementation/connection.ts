/** Browser-only bootstrap edge. The one-use token is removed from history before any API call. */
import { BootstrapToken } from "@executor-js/local-server/auth";
import { useAtomSet } from "@effect/atom-react";
import { Effect, Option, Schema } from "effect";
import { useEffect } from "react";
import { pairingTokenAtom } from "../contracts/connection.ts";

/** Read one startup token and erase its fragment; remove the obsolete manually pasted key. */
export const readPairingToken = Effect.gen(function* () {
  const input = new URLSearchParams(window.location.hash.slice(1)).get("pair");
  if (input !== null)
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  yield* Effect.try(() => sessionStorage.removeItem("executor.local.api-key")).pipe(Effect.ignore);
  if (input === null) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(BootstrapToken)(input));
});

/** A link can reach an existing tab without reloading its document. */
export function usePairingLinks() {
  const setToken = useAtomSet(pairingTokenAtom);
  useEffect(() => {
    const receive = () => {
      const token = Effect.runSync(readPairingToken);
      if (token !== undefined) setToken(token);
    };
    window.addEventListener("hashchange", receive);
    // Also cover a link arriving between the entry-point read and this listener.
    receive();
    return () => window.removeEventListener("hashchange", receive);
  }, [setToken]);
}
