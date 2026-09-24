import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Cause, Data, Effect, Exit, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { getExecutorOrganizationHeaders } from "@executor-js/react/api/server-connection";
import { useAuth } from "../auth";

const Status = Schema.Union([
  Schema.Struct({ state: Schema.Literal("member") }),
  Schema.Struct({ state: Schema.Literal("required") }),
  Schema.Struct({ state: Schema.Literal("verified"), expiresAt: Schema.Number }),
]);
const Challenge = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("challenge") }),
  Schema.Struct({
    kind: Schema.Literal("enroll"),
    secret: Schema.String,
    qrCode: Schema.String.check(Schema.isPattern(/^data:image\/png;base64,/)),
  }),
]);
const Message = Schema.Struct({ message: Schema.String });
const Verified = Schema.Struct({ verified: Schema.Literal(true) });
const Canceled = Schema.Struct({ canceled: Schema.Literal(true) });
const unavailable = "Verification is unavailable. Try again.";

class VerificationError extends Data.TaggedError("VerificationError")<{
  readonly message: string;
}> {}
const decodeStatus = Schema.decodeUnknownOption(Status);
const decodeChallenge = Schema.decodeUnknownOption(Challenge);
const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeVerified = Schema.decodeUnknownOption(Verified);
const decodeCanceled = Schema.decodeUnknownOption(Canceled);

function request<A>(
  path: string,
  decode: (value: unknown) => Option.Option<A>,
  body?: Readonly<Record<string, string>>,
): Effect.Effect<A, VerificationError> {
  return Effect.gen(function* () {
    const { response, raw } = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const url = `/api/auth/admin-mfa${path}`;
      const base = body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
      const payload = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
      const response = yield* client.execute(
        HttpClientRequest.setHeaders(payload, getExecutorOrganizationHeaders()),
      );
      const raw = yield* response.json;
      return { response, raw };
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(() => new VerificationError({ message: unavailable })),
    );
    if (response.status < 200 || response.status >= 300) {
      const message = Option.getOrNull(decodeMessage(raw));
      return yield* new VerificationError({ message: message?.message ?? unavailable });
    }
    const parsed = decode(raw);
    if (Option.isNone(parsed)) return yield* new VerificationError({ message: unavailable });
    return parsed.value;
  });
}

/** Require a second factor only before mounting organization API key controls. */
export function AdminVerification({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const scope = auth.status === "authenticated" ? auth.organization?.id : undefined;
  if (!scope) return null;
  return <VerificationFlow key={scope}>{children}</VerificationFlow>;
}

function VerificationFlow({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<typeof Status.Type | null>(null);
  const [challenge, setChallenge] = useState<typeof Challenge.Type | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const codeId = useId();

  const run = async <A,>(
    effect: Effect.Effect<A, VerificationError>,
    signal: AbortSignal,
    onSuccess: (value: A) => void,
  ) => {
    const exit = await Effect.runPromiseExit(effect, { signal });
    if (signal.aborted) return;
    if (Exit.isSuccess(exit)) onSuccess(exit.value);
    else setError(Option.getOrNull(Cause.findErrorOption(exit.cause))?.message ?? unavailable);
  };

  useEffect(() => {
    const owner = new AbortController();
    controller.current = owner;
    const load = () => run(request("", decodeStatus), owner.signal, setStatus);
    void load();
    window.addEventListener("focus", load);
    return () => {
      owner.abort();
      window.removeEventListener("focus", load);
    };
  }, []);

  useEffect(() => {
    if (status?.state !== "verified") return;
    const timeout = window.setTimeout(
      () => {
        setStatus({ state: "required" });
        setChallenge(null);
        setCode("");
      },
      Math.max(0, status.expiresAt * 1000 - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [status]);

  const act = async (action: "start" | "verify" | "cancel" | "retry" | "lock") => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setError(null);
    if (action === "lock") {
      await run(request("/lock", decodeCanceled, {}), signal, () => window.location.reload());
    } else if (action === "start") {
      await run(request("/start", decodeChallenge, {}), signal, (next) => {
        setChallenge(next);
        setCode("");
      });
    } else if (action === "verify") {
      await run(request("/verify", decodeVerified, { code }), signal, () => {
        setChallenge(null);
        setCode("");
        // Reload clears cached admin requests and the enrollment secret while
        // retaining the current organization's URL.
        window.location.reload();
      });
    } else if (action === "cancel") {
      await run(request("/cancel", decodeCanceled, {}), signal, () => {
        setChallenge(null);
        setCode("");
      });
    } else {
      await run(request("", decodeStatus), signal, setStatus);
    }
    if (!signal.aborted) setBusy(false);
  };

  if (status?.state === "member") return children;
  if (status?.state === "verified")
    return (
      <>
        <div className="px-6 pt-4 text-sm text-muted-foreground">
          Organization key management is unlocked for this session.{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            disabled={busy}
            onClick={() => void act("lock")}
          >
            Lock key management
          </Button>
        </div>
        {children}
      </>
    );

  return (
    <section
      className="m-6 max-w-lg rounded-lg border border-border bg-card p-6"
      aria-label="Organization key verification"
    >
      <h2 className="text-lg font-medium">Unlock organization keys</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Use an authenticator app to manage organization API keys for 15 minutes.
      </p>
      <Link
        to="/{-$orgSlug}"
        params={(previous) => previous}
        className="mt-3 block text-sm underline"
      >
        Back to workspace
      </Link>
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {!status ? (
        <div className="mt-4">
          {error ? (
            <Button onClick={() => void act("retry")} disabled={busy}>
              Try again
            </Button>
          ) : (
            <p role="status">Checking access…</p>
          )}
        </div>
      ) : challenge ? (
        <form
          className="mt-5 space-y-4 ph-no-capture sentry-block"
          data-ph-block
          onSubmit={(event) => {
            event.preventDefault();
            void act("verify");
          }}
        >
          {challenge.kind === "enroll" && (
            <div className="space-y-3">
              <p className="text-sm">Scan this code with your authenticator app.</p>
              <img
                src={challenge.qrCode}
                alt="Authenticator setup QR code"
                className="size-44 rounded bg-white p-2"
              />
              <details className="text-sm">
                <summary className="cursor-pointer">Enter a setup key instead</summary>
                <p className="mt-2 break-all font-mono select-all">{challenge.secret}</p>
              </details>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor={codeId}>Six-digit code</Label>
            <Input
              id={codeId}
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Verify"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void act("start")}
            >
              Start again
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void act("cancel")}
            >
              Cancel
            </Button>
          </div>
          {challenge.kind === "challenge" && (
            <p className="text-sm text-muted-foreground">
              Lost your authenticator?{" "}
              <a
                className="underline"
                href="mailto:rhys@executor.sh?subject=Organization%20key%20access%20recovery"
              >
                Contact support
              </a>
              .
            </p>
          )}
        </form>
      ) : (
        <Button className="mt-5" onClick={() => void act("start")} disabled={busy}>
          {busy ? "Opening…" : "Continue"}
        </Button>
      )}
    </section>
  );
}
