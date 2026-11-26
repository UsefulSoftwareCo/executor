import { startErrorReporting, reportBootFailure } from "./implementation/error-reporting-client.ts";
const publicEmailPage = window.location.pathname.startsWith("/email/unsubscribe");
if (!publicEmailPage) startErrorReporting();
void import("./main.tsx").catch((error) => {
  if (!publicEmailPage) reportBootFailure(error);
  console.error("Dashboard could not start");
});
