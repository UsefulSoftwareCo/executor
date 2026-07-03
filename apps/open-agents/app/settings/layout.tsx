import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session/get-server-session";
import { getSessionUserInfo } from "@/lib/session/user-info";
import { SettingsLayoutClient } from "./settings-layout-client";

function getRequestUrlFromHeaders(requestHeaders: Headers) {
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host ?? "localhost"}/settings`;
}

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  const sessionInfo = await getSessionUserInfo(
    session,
    getRequestUrlFromHeaders(await headers()),
  );

  if (!sessionInfo.user) {
    redirect("/");
  }

  return (
    <SettingsLayoutClient sessionInfo={sessionInfo}>
      {children}
    </SettingsLayoutClient>
  );
}
