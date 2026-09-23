import { AccountId, AppId } from "@executor-js/sdk";
import { notFound } from "@tanstack/react-router";
import { Option, Schema } from "effect";

/** Reject malformed app URLs before mounting any app reads. */
export function parseAppParams(params: { readonly appId: string }) {
  const appId = Schema.decodeUnknownOption(AppId)(params.appId);
  if (Option.isNone(appId)) throw notFound();
  return { appId: appId.value };
}

/** Reject malformed account URLs before mounting any account reads. */
export function parseAccountParams(params: { readonly accountId: string }) {
  const accountId = Schema.decodeUnknownOption(AccountId)(params.accountId);
  if (Option.isNone(accountId)) throw notFound();
  return { accountId: accountId.value };
}
