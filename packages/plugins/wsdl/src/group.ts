import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  InternalError,
  OrgWriteDeniedError,
  IntegrationAlreadyExistsError,
} from "@executor-js/sdk/shared";
import { AddWsdlInput } from "./shared";
import { WsdlError } from "./errors";
export const WsdlGroup = HttpApiGroup.make("wsdl").add(
  HttpApiEndpoint.post("addIntegration", "/wsdl/integrations", {
    payload: AddWsdlInput,
    success: Schema.Struct({ slug: Schema.String, name: Schema.String, toolCount: Schema.Number }),
    error: [
      IntegrationAlreadyExistsError,
      InternalError,
      OrgWriteDeniedError,
      IntegrationAlreadyExistsError,
      WsdlError.annotate({ httpApiStatus: 400 }),
    ],
  }),
);
