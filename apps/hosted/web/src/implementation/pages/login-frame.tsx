import type { ReactNode } from "react";

/** Shared themed card for sign-in, SSO, credential enrollment, and invitations. */
export function LoginFrame({
  title,
  children,
  footer,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <main className="auth-page flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 text-foreground">
      <div className="w-full max-w-110">
        <a href="/" aria-label="Executor home" className="mx-auto mb-5 block size-10">
          <img src="/favicon.png" alt="" className="size-10" />
        </a>
        <h1 className="mb-6 text-center text-2xl font-semibold leading-8 tracking-tight">
          {title}
        </h1>
        <section className="auth-form rounded-2xl border border-border bg-muted/50 p-12 max-[520px]:p-6 [&_form]:flex [&_form]:flex-col [&_form]:gap-6 [&_label]:flex [&_label]:flex-col [&_label]:gap-2 [&_label]:text-sm [&_label]:font-semibold [&_input]:h-10 [&_input]:bg-background [&_input]:text-base [&_input]:font-normal [&_input]:shadow-none [&_input]:placeholder:text-muted-foreground [&_form_>_button]:min-h-10">
          {children}
        </section>
        {footer && (
          <div className="mt-5 flex flex-col items-center gap-4 text-sm text-muted-foreground [&_.auth-legal]:mt-0">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}
