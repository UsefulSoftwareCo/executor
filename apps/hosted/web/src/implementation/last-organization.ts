import {
  lastOrganizationCookie,
  type LastOrganization,
} from "@executor-js/hosted-server/browser/contracts";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { Option, Schema } from "effect";
import { Cookies } from "effect/http";
import { LastOrganization as LastOrganizationSchema } from "@executor-js/hosted-server/browser/contracts";

const lifetime = 365 * 24 * 60 * 60;
const name = () =>
  lastOrganizationCookie(window.location.host, window.location.protocol === "https:");
const attributes = () =>
  `Path=/; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;

const current = (): Option.Option<LastOrganization> => {
  const value = Cookies.parseHeader(document.cookie)[name()];
  return value === undefined
    ? Option.none()
    : Schema.decodeUnknownOption(Schema.fromJsonString(LastOrganizationSchema))(value);
};

export const clearLastOrganization = (): void => {
  document.cookie = `${name()}=; Max-Age=0; ${attributes()}`;
};

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

export const forgetOrganization = (user: string, organization: OrganizationId): void => {
  const saved = current();
  if (
    Option.isSome(saved) &&
    saved.value.user === user &&
    saved.value.organization === organization
  )
    clearLastOrganization();
};
