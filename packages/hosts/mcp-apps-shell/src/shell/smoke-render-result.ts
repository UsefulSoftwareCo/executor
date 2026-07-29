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
  | {
      readonly status: "ok";
      /**
       * The markup the render produced, when it produced any within the cap.
       *
       * The smoke render already drives a full `renderToReadableStream` to
       * completion; this is the HTML it was throwing away. Because the harness
       * renders with a transport that never settles, the markup is the
       * artifact's LOADING state — its real composition (cards, tables, chart
       * frames, skeletons) with no data in it. That is what makes it storable
       * as ordinary artifact metadata: it is derived from the source, not from
       * anybody's rows.
       *
       * Absent whenever nothing can be concluded — no harness, a sandbox
       * failure, a render over the size cap. Every consumer treats absent as
       * "fall back", never as "empty".
       */
      readonly markup?: string;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly componentStack?: string;
    };
