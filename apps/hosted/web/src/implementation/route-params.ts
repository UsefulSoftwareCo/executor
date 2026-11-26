import { AccountConnectionId, AccountId, AppId, WebhookId } from "@executor-js/sdk";
import { notFound } from "@tanstack/react-router";
import { Option, Schema } from "effect";

const decodeParam = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
): S["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  if (Option.isNone(decoded)) throw notFound();
  return decoded.value;
};

export function parseAppParams(params: { readonly appId: string }) {
  return { appId: decodeParam(AppId, params.appId) };
}

export function parseAccountParams(params: { readonly accountId: string }) {
  return { accountId: decodeParam(AccountId, params.accountId) };
}

export function parseConnectionParams(params: { readonly connectionId: string }) {
  return { connectionId: decodeParam(AccountConnectionId, params.connectionId) };
}

export function parseWebhookParams(params: {
  readonly appId: string;
  readonly subscriptionId: string;
}) {
  return {
    appId: decodeParam(AppId, params.appId),
    subscriptionId: decodeParam(WebhookId, params.subscriptionId),
  };
}
