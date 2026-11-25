import { recordRequestRejection } from "@executor-js/telemetry/http";
import { Effect, SchemaIssue } from "effect";
import { type HttpApiError, HttpApiMiddleware } from "effect/http-api";
import {
  RequestInvalid,
  type RequestIssue,
  type RequestPart,
  RequestRejection,
} from "../contracts/shared.ts";

const parts: Partial<Record<HttpApiError.HttpApiSchemaError["kind"], RequestPart>> = {
  Params: "path",
  Headers: "headers",
  Query: "query",
  Payload: "body",
};

const maxIssues = 10;
const maxExpected = 300;
const format = SchemaIssue.makeFormatterStandardSchemaV1();
const segment = (key: PropertyKey) =>
  typeof key === "number" ? `[${key}]` : `.${String(key).slice(0, 64)}`;

const issues = (error: HttpApiError.HttpApiSchemaError): ReadonlyArray<RequestIssue> => {
  const found = new Map<string, RequestIssue>();
  for (const issue of format(error.cause.issue).issues) {
    const path = `$${(issue.path ?? []).map((key) => segment(typeof key === "object" ? key.key : key)).join("")}`;
    const expected = issue.message.slice(0, maxExpected);
    found.set(`${path}\n${expected}`, { path, expected });
  }
  return [...found.values()].slice(0, maxIssues);
};

export const rejectRequest = (error: HttpApiError.HttpApiSchemaError) => {
  const part = parts[error.kind];
  return part === undefined
    ? Effect.fail(error)
    : recordRequestRejection(error).pipe(
        Effect.andThen(Effect.fail(new RequestInvalid({ part, issues: issues(error) }))),
      );
};

export const requestRejections = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestRejection,
  rejectRequest,
);
