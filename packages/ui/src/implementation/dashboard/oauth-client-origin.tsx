import type { OAuthClient } from "@executor-js/sdk";
import { LocalTime } from "../components/local-time.tsx";

type ClientIdentity = Pick<OAuthClient, "id" | "issuer" | "clientId">;

export const sharesClientId = (client: ClientIdentity, clients: ReadonlyArray<ClientIdentity>) =>
  clients.some(
    (other) =>
      other.id !== client.id &&
      other.issuer === client.issuer &&
      other.clientId === client.clientId,
  );

export const issuerLabel = (issuer: string) => {
  if (!URL.canParse(issuer)) return issuer;
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  return `${url.host}${path}`;
};

const added: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

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
