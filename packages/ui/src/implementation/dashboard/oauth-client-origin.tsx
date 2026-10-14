/**
 * Stored OAuth clients have no names: the authorization server they sign in at and their public
 * client ID identify one. Two clients of a server can share a client ID, such as an app's public
 * client saved under several settings before clients were stored, so where they do, how and when
 * each was added tells them apart, and the end of its stored ID when even that matches. None of it
 * is secret.
 */
import type { OAuthClient } from "@executor-js/sdk";
import { LocalTime } from "../components/local-time.tsx";

type ClientIdentity = Pick<OAuthClient, "id" | "issuer" | "clientId">;

/** Whether another of these clients has the same server and public client ID. */
export const sharesClientId = (client: ClientIdentity, clients: ReadonlyArray<ClientIdentity>) =>
  clients.some(
    (other) =>
      other.id !== client.id &&
      other.issuer === client.issuer &&
      other.clientId === client.clientId,
  );

/**
 * A short label for an authorization server: its host, and its path when it has one, such as a
 * tenant or the token endpoint that names a server declared without an issuer.
 */
export const issuerLabel = (issuer: string) => {
  if (!URL.canParse(issuer)) return issuer;
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  return `${url.host}${path}`;
};

const added: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/** How and when a client was added, and with a shared client ID, the end of its stored ID. */
export function OAuthClientOrigin({
  client,
  clients,
}: {
  readonly client: Pick<OAuthClient, "id" | "issuer" | "clientId" | "source" | "createdAt">;
  readonly clients: ReadonlyArray<ClientIdentity>;
}) {
  return (
    <>
      {client.source === "manual" ? "Registered" : "Automatic"} · Added{" "}
      <LocalTime value={client.createdAt} options={added} />
      {sharesClientId(client, clients) ? ` · …${client.id.slice(-6)}` : null}
    </>
  );
}
