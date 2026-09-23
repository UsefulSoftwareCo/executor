import type { ReactNode } from "react";
import { Match } from "effect";
import type { GrantTarget } from "@executor-js/mcp-auth/grants";
import { Skeleton } from "../components/skeleton.tsx";

/** Stable consent shell shared by local and hosted connections, including their loading state. */
export function McpConsentLayout({
  children,
  description,
}: {
  readonly children: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <main className="mcp-consent-page min-h-dvh py-[48px] px-[20px] max-[480px]:py-[28px] max-[480px]:px-[16px]">
      <section className="mcp-consent-form w-full max-w-150 my-0 mx-auto flex flex-col gap-7 [&_h1]:text-[28px] [&_h1]:leading-[1.2] [&_h1]:[margin:0_0_10px] max-[480px]:gap-5.5 max-[480px]:[&_h1]:text-[24px]">
        <div className="mcp-consent-brand flex items-center gap-2.25 text-[19px] [font-weight:550] tracking-[-0.04em] mb-2 [&_img]:w-6.25 [&_img]:h-6.25">
          <img src="/favicon.png" alt="" />
          executor
        </div>
        <header>
          <h1 className="font-semibold tracking-[-0.035em]">Connect to Executor</h1>
          <div className="mcp-consent-intro text-muted-foreground text-[14px] leading-[1.6] [&_strong]:text-foreground [&_strong]:[font-weight:550]">
            {description}
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}

/** Loading keeps the same shape as the consent form without flashing a full-page spinner. */
export function McpConsentLoading() {
  return (
    <McpConsentLayout description={<Skeleton className="h-5 w-3/4" />}>
      <div
        role="status"
        aria-label="Loading connection"
        className="mcp-consent-loading flex flex-col gap-3 [&_.mcp-consent-summary]:mt-3 [&_.mcp-consent-summary]:min-h-37 [&_.mcp-consent-actions]:mt-4"
      >
        <span className="sr-only">Loading connection…</span>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
        <div className="mcp-consent-summary flex flex-col gap-5 p-[22px] border border-border rounded-[10px] [&_h2]:[margin:0_0_6px] [&_h2]:text-[14px] [&_h2]:[font-weight:550] [&_p]:m-0 [&_p]:text-[13px] [&_p]:leading-[1.6] [&_p]:text-muted-foreground">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="mcp-consent-actions flex items-center justify-end gap-2.5 border-t border-t-border pt-5 [&_>_p]:mr-auto [&_>_p]:text-muted-foreground [&_>_p]:text-[12px] max-[480px]:flex-wrap">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </McpConsentLayout>
  );
}

/**
 * A registered client chooses its own display name, so the name alone cannot tell
 * the person who is asking. The authorization server has already matched this
 * redirect URI against the client's registration, and it is where the
 * authorization code is delivered, so it is shown as the destination.
 */
export const consentDestination = (redirectUri: string | null): string | undefined => {
  if (redirectUri === null || redirectUri.length === 0) return undefined;
  const target = URL.parse(redirectUri);
  if (target === null) return undefined;
  return target.origin === "null" ? `${target.protocol}//` : target.origin;
};

/** OAuth's requested resource determines this read-only approval summary. */
export function McpConsentSummary({
  target,
  destination,
}: {
  readonly target: GrantTarget;
  readonly destination?: string | undefined;
}) {
  const approval =
    target.kind === "api"
      ? undefined
      : Match.value(target.mode).pipe(
          Match.when("browser", () => ({
            title: "Approvals in Executor",
            detail: "Calls that need approval wait for you to review them in your browser.",
          })),
          Match.when("native", () => ({
            title: "Approvals in your client",
            detail: "Your connected client handles approval prompts.",
          })),
          Match.when("model", () => ({
            title: "Approvals through your agent",
            detail: "Your agent collects responses and resumes calls that need approval.",
          })),
          Match.exhaustive,
        );
  return (
    <div className="mcp-consent-summary flex flex-col gap-5 p-[22px] border border-border rounded-[10px] [&_h2]:[margin:0_0_6px] [&_h2]:text-[14px] [&_h2]:[font-weight:550] [&_p]:m-0 [&_p]:text-[13px] [&_p]:leading-[1.6] [&_p]:text-muted-foreground">
      <div>
        <h2>{target.kind === "api" ? "Connect to the Executor API" : "Access to your apps"}</h2>
        <p>
          {target.kind === "api"
            ? "This app can use the API with your account’s permissions."
            : "This connection can use all apps available to you. Your account’s permissions still apply."}
        </p>
      </div>
      {approval !== undefined && (
        <div>
          <h2>{approval.title}</h2>
          <p>{approval.detail}</p>
        </div>
      )}
      {destination !== undefined && (
        <div className="mcp-consent-destination">
          <h2>Where access is sent</h2>
          <p>
            Approving sends this connection’s access to{" "}
            <span className="mcp-consent-destination-origin break-all text-foreground [font-weight:550]">
              {destination}
            </span>
            . Only continue if you recognize it.
          </p>
        </div>
      )}
    </div>
  );
}
