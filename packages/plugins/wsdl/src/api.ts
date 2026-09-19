import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { addGroup, capture } from "@executor-js/api";
import { definePlugin } from "@executor-js/sdk/core";
import { wsdlPlugin } from "./index";

import { WsdlGroup } from "./group";
export { WsdlGroup } from "./group";
export class WsdlExtension extends Context.Service<
  WsdlExtension,
  ReturnType<NonNullable<ReturnType<typeof wsdlPlugin>["extension"]>>
>()("WsdlExtension") {}
const Handlers = HttpApiBuilder.group(addGroup(WsdlGroup), "wsdl", (handlers) =>
  handlers.handle("addIntegration", ({ payload }) =>
    capture(
      Effect.gen(function* () {
        const extension = yield* WsdlExtension;
        return yield* extension.addIntegration(payload);
      }),
    ),
  ),
);
export const wsdlHttpPlugin = definePlugin(() => ({
  ...wsdlPlugin(),
  routes: () => WsdlGroup,
  handlers: () => Handlers,
  extensionService: WsdlExtension,
}));
