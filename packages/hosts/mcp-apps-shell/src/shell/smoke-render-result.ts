/**
 * What a smoke render can conclude.
 *
 * Its own module because it is the one thing the sandbox harness and the host
 * both name: the harness produces it inside QuickJS, the host parses it back
 * out. Keeping it here means neither side imports the other's graph — the host
 * must not pull React in, and the harness must not pull the kernel in.
 *
 * `ok` covers both "rendered" and "we could not tell". Only `failed` is ever a
 * reason to refuse a create.
 */
export type SmokeRenderResult =
  | { readonly status: "ok" }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly componentStack?: string;
    };
