import { StartServer } from "@tanstack/react-start/server";
import {
  createSsrStreamResponse,
  defineHandlerCallback,
  getSsrStatus,
  transformReadableStreamWithRouter,
} from "@tanstack/react-router/ssr/server";
import { renderToReadableStream } from "react-dom/server";

export const completeDocumentHandler = defineHandlerCallback(
  async ({ request, router, responseHeaders }) => {
    const rendered = await renderToReadableStream(<StartServer router={router} />, {
      signal: request.signal,
      nonce: router.options.ssr?.nonce,
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onError: (error) => {
        if (!request.signal.aborted) console.error("Dashboard render failed", error);
      },
    });
    await rendered.allReady;
    return createSsrStreamResponse(
      router,
      new Response(
        transformReadableStreamWithRouter(router, rendered, {
          rendererSafePoint: "script-close",
          signal: request.signal,
        }),
        { status: getSsrStatus(router), headers: responseHeaders },
      ),
    );
  },
);
