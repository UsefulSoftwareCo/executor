import { Effect } from "effect";

// Hosted service hosts (e.g. resend.emulators.dev) are control plane only —
// there is no shared default instance behind them. Every scenario creates its
// own isolated instance and works against the returned providerBaseUrl, which
// also keeps ledger assertions free of cross-run pollution. The server
// generates an unguessable instance name; the label is a readable prefix.
export const createEmulatorInstance = (service: string, label = "e2e") =>
  Effect.promise(async () => {
    const response = await fetch(`https://${service}.emulators.dev/_emulate/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance: label }),
    });
    if (!response.ok) {
      throw new Error(`${service} emulator instance creation failed: ${response.status}`);
    }
    const instance = (await response.json()) as { readonly providerBaseUrl: string };
    return instance.providerBaseUrl;
  });
