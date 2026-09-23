import { createFileRoute, useLocation } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";

/** Public confirmation: opening a link never saves a preference or requires a session. */
export const Route = createFileRoute("/email/unsubscribe")({
  validateSearch: (search: Record<string, unknown>) => ({
    result:
      search.result === "unsubscribed" || search.result === "invalid" || search.result === "error"
        ? search.result
        : undefined,
  }),
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { result } = Route.useSearch();
  const { hash } = useLocation();
  const token = hash.replace(/^#/, "");
  const valid = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/.test(token);
  const complete = result === "unsubscribed";
  const invalid = !complete && (result === "invalid" || !valid);
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <section className="w-full max-w-md space-y-5">
        <p className="text-sm font-medium text-muted-foreground">Executor</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {complete
            ? "You’re unsubscribed"
            : invalid
              ? "This link is not valid"
              : "Unsubscribe from optional emails?"}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {complete
            ? "You won’t receive optional emails from Executor. You can still request sign-in codes and receive essential account emails."
            : invalid
              ? "Use the link in your latest Executor email, or reply to rhys@executor.sh for help."
              : "We’ll stop sending optional emails to this account. You can still request sign-in codes and receive essential account emails."}
        </p>
        {result === "error" && (
          <p role="alert" className="text-sm text-destructive">
            We couldn’t save your preference. Try again.
          </p>
        )}
        {!complete && !invalid && (
          <form action="/api/email/unsubscribe" method="post">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="List-Unsubscribe" value="One-Click" />
            <Button type="submit">Unsubscribe</Button>
          </form>
        )}
      </section>
    </main>
  );
}
