import { Option } from "effect";
import type { HealthCheckCandidateParameter } from "@executor-js/sdk/core";

import type { OperationBinding } from "./types";

export const getHealthCheckParameters = (
  operation: Pick<OperationBinding, "parameters" | "requestBody">,
): HealthCheckCandidateParameter[] => [
  ...operation.parameters.map((parameter) => ({
    name: parameter.name,
    location: parameter.location,
    required: parameter.required,
    ...(Option.isSome(parameter.description) ? { description: parameter.description.value } : {}),
  })),
  ...(Option.isSome(operation.requestBody)
    ? [{ name: "body", location: "body", required: operation.requestBody.value.required }]
    : []),
];
