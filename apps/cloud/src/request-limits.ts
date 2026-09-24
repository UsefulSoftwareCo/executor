/** Maximum accepted request body, including streamed imports and MCP calls. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Read a bounded body before dispatch, so no handler can bypass the byte limit. */
export const limitRequestBody = async (
  request: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Request | Response> => {
  if (!request.body) return request;
  const reject = () => Response.json({ error: "Request body too large" }, { status: 413 });
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await request.body.cancel();
    return reject();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: release the native Web stream reader on every exit before entering the Effect app
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return reject();
      }
      chunks.push(new Uint8Array(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  // No clone/tee: only the bounded body reaches downstream parsers and proxies.
  return new Request(request, { body: new Blob(chunks) });
};
