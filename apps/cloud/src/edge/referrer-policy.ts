/** Prevent document and redirect URLs (including OAuth codes) from becoming
 * Referer headers. Preserve the response stream, cookies and status. WebSocket
 * upgrades cannot navigate a browser and must retain their platform handle. */
export const withPrivateReferrerPolicy = (response: Response): Response => {
  if (response.status === 101) return response;
  const result = new Response(response.body, response);
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
};
