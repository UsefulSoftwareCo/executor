import type {
  PrivateInvocation,
  PrivateInvocationRpc,
  PrivatePermit,
} from "../contracts/private-invocation.ts";

const refuse = () => {
  throw new Error("Private invocation unavailable");
};
const opaque = <T extends object>(value: T): T =>
  Object.freeze(
    Object.assign(Object.create(null), value, {
      toJSON: refuse,
      toString: refuse,
      [Symbol.toPrimitive]: refuse,
    }),
  );
export const unavailableInvocation: PrivateInvocation = opaque({ require: async () => refuse() });

/** Only the generated trusted bridge supplies this RPC; factories receive unavailableInvocation. */
export const isolatedPrivateInvocation = (
  rpc: PrivateInvocationRpc,
  signal: AbortSignal,
): PrivateInvocation => {
  let required = false;
  return opaque({
    require: async (operationId: string): Promise<PrivatePermit> => {
      if (signal.aborted || required || typeof operationId !== "string" || !operationId)
        return refuse();
      required = true;
      await rpc({ privateInvocation: { operation: "require", operationId } });
      let forwarded = false;
      return opaque({
        forward: async (bindingId: string, input: unknown) => {
          if (signal.aborted || forwarded) return refuse();
          forwarded = true;
          return rpc({ privateInvocation: { operation: "forward", bindingId, input } });
        },
      });
    },
  });
};
