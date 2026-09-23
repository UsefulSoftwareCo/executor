import { createFileRoute } from "@tanstack/react-router";
import { AppSignInId } from "@executor-js/local-server/app-ui";
import { Option, Schema } from "effect";
import { AuthenticationGate } from "../app.tsx";
import { AppSignInPage } from "../pages/app-sign-in.tsx";

/** Sign-in is a standalone product page; it does not mount dashboard inventory. */
export const Route = createFileRoute("/app-auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    request: Option.getOrUndefined(Schema.decodeUnknownOption(AppSignInId)(search.request)),
  }),
  component: AppAuthentication,
});

function AppAuthentication() {
  const { request } = Route.useSearch();
  if (request === undefined)
    return (
      <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Sign-in request missing
        </h1>
        <p>Open the app URL to sign in.</p>
      </div>
    );
  return (
    <AuthenticationGate>
      <AppSignInPage key={request} request={request} />
    </AuthenticationGate>
  );
}
