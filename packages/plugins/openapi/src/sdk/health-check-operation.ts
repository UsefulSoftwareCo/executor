import { Option } from "effect";
import type { HealthCheckCandidateParameter } from "@executor-js/sdk/core";

import type { OperationBinding } from "./types";
/** Some HTTP RPC APIs expose reads only through POST. The editor warns users
 * to select a read operation before enabling these automatic probes. */
export const isSupportedHealthCheckMethod = (method: string): boolean =>
  ["get", "head", "options", "post"].includes(method.toLowerCase());

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
