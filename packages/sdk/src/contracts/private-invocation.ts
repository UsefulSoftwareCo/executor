import { Context, type Effect, type Redacted } from "effect";
import type { PrivateInvocationRpc } from "apps/contracts";

export const privateInvocationCapability = {
  version: 1,
  header: "Private-Invocation",
  directCallOnly: true,
} as const;
export interface PrivateBinding {
  readonly digestVersion: "rfc8785-sha256-v1";
  readonly recipientPrincipal: string;
  readonly appId: string;
  readonly buildId: string;
  readonly toolPath: string;
  readonly accountsDigest: string;
  readonly action: "call";
  readonly inputDigest: string;
}
/** Product-owned verifier. No trust registration is exposed through tool input or app code. */
export interface PrivateInvocationVerifier {
  readonly namespace: string;
  readonly redeem: (
    reference: Redacted.Redacted<string>,
    binding: PrivateBinding,
    signal: AbortSignal,
  ) => Promise<PrivateInvocationRpc>;
}
/** Set only around one MCP direct call's authorized SDK call, never discovery/cache/evaluation. */
export const PrivateInvocationRequest = Context.Reference<
  | {
      readonly reference: Redacted.Redacted<string>;
      readonly principal: string;
      readonly verifier: PrivateInvocationVerifier;
      readonly reauthorize: (
        input: Pick<
          Parameters<import("./executor.ts").Executor["tools"]["call"]>[0],
          "app" | "version" | "tool" | "accounts"
        >,
      ) => Effect.Effect<void, Error>;
    }
  | undefined
>("executor/PrivateInvocationRequest", { defaultValue: () => undefined });
