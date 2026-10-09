/** Browser writes for the last-organization memory; the server reads it for `/`. */
import {
  lastOrganizationCookie,
  type LastOrganization,
} from "@executor-js/hosted-server/browser/contracts";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { Option, Schema } from "effect";
import { Cookies } from "effect/http";
import { LastOrganization as LastOrganizationSchema } from "@executor-js/hosted-server/browser/contracts";

const lifetime = 365 * 24 * 60 * 60;
const name = () => lastOrganizationCookie(window.location.host);
const attributes = () =>
  `Path=/; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;

const current = (): Option.Option<LastOrganization> => {
  const value = Cookies.parseHeader(document.cookie)[name()];
  return value === undefined
    ? Option.none()
    : Schema.decodeUnknownOption(Schema.fromJsonString(LastOrganizationSchema))(value);
};

/** Forget every destination, after sign-out or a change of user. */
export const clearLastOrganization = (): void => {
  document.cookie = `${name()}=; Max-Age=0; ${attributes()}`;
};

/** Record a foreground organization only after the host has confirmed the user's access. */
export const rememberOrganization = (user: string, organization: OrganizationId): void => {
  const saved = current();
  if (
    Option.isSome(saved) &&
    saved.value.user === user &&
    saved.value.organization === organization
  )
    return;
  const value = encodeURIComponent(JSON.stringify({ user, organization }));
  document.cookie = `${name()}=${value}; Max-Age=${lifetime}; ${attributes()}`;
};

/** Forget a rejected destination without removing a newer choice made in another tab. */
export const forgetOrganization = (user: string, organization: OrganizationId): void => {
  const saved = current();
  if (
    Option.isSome(saved) &&
    saved.value.user === user &&
    saved.value.organization === organization
  )
    clearLastOrganization();
};
