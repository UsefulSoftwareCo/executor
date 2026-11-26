import { AppId } from "@executor-js/sdk";
export { AppSignInFailure, AppSignInId } from "apps/ui/auth/contracts";
export const appOrigin = (app: AppId, port: number) =>
  `http://${app.replace(/^app_/, "app-")}.localhost:${port}`;
export const appFromHost = (host: string | undefined, port: number) => {
  const match = new RegExp(
    `^app-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\.localhost:${port}$`,
  ).exec(host ?? "");
  return match?.[1] === undefined ? undefined : AppId.make(`app_${match[1]}`);
};
export const appSessionCookie = (port: number) => `executor_app_${port}`;
