import React from "react";
import { trackEvent } from "@executor-js/react/api/analytics";
import { AUTH_PATHS } from "../../auth/api";
import { safeReturnTo } from "../../auth/return-to";

export const LoginPage = ({ returnTo }: { returnTo?: string | undefined }) => {
  const destination = safeReturnTo(returnTo);
  const loginHref = destination
    ? `${AUTH_PATHS.login}?returnTo=${encodeURIComponent(destination)}`
    : AUTH_PATHS.login;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="font-mono text-4xl">Executor</h1>
          <p className="text-sm text-muted-foreground">Sign in to manage your tools and sources</p>
        </div>
        <a
          href={loginHref}
          onClick={() => trackEvent("login_cta_clicked")}
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
        >
          Sign in
        </a>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <a href="/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </a>
          <a href="/terms" className="transition-colors hover:text-foreground">
            Terms
          </a>
        </div>
      </div>
    </div>
  );
};
