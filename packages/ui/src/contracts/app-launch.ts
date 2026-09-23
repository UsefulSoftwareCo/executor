/** App choices carry a safe return path, never a cross-origin destination or a global preference. */
import { AppReturnPath } from "apps/ui/auth/contracts";
import { Option, Schema } from "effect";
import type { ProfileId } from "@executor-js/sdk";
/** Decode the same app-origin return contract used by the sign-in protocol. */
export const parseAppLaunchSearch = (search: Record<string, unknown>) => ({
  returnTo: Option.getOrElse(Schema.decodeUnknownOption(AppReturnPath)(search.returnTo), () =>
    AppReturnPath.make("/"),
  ),
});
/** The trusted product supplies the app origin; account identity is explicit in the opened tab. */
export function appLaunchUrl(
  origin: string,
  returnTo: AppReturnPath,
  profile?: ProfileId,
  fragment = "",
): string {
  const url = new URL(returnTo, origin);
  if (url.hash === "") url.hash = fragment;
  if (profile === undefined) url.searchParams.delete("profile");
  else url.searchParams.set("profile", profile);
  return url.href;
}
export type { AppReturnPath };
