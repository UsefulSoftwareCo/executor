const AUTHORIZE_PATH = "/api/auth/mcp/authorize";
const CONSENT_PAGE = "/mcp-consent";

export const promptWithConsent = (prompt: string | null): string => {
  const set = new Set((prompt ?? "").split(/\s+/).filter((value) => value.length > 0));
  set.add("consent");
  return Array.from(set).join(" ");
};

export const withForcedMcpConsent = (request: Request): Request => {
  if (request.method !== "GET") return request;
  const url = new URL(request.url);
  if (url.pathname !== AUTHORIZE_PATH) return request;
  const prompt = url.searchParams.get("prompt");
  if (prompt && prompt.split(/\s+/).includes("consent")) return request;
  url.searchParams.set("prompt", promptWithConsent(prompt));
  return new Request(url, request);
};

export const consentRedirectClientId = (location: string | null): string | null => {
  if (!location) return null;
  const url = new URL(location, "http://host.internal");
  if (url.pathname !== CONSENT_PAGE) return null;
  if (url.searchParams.get("client_name")) return null;
  return url.searchParams.get("client_id");
};

export const withClientName = (location: string, clientName: string): string => {
  const url = new URL(location, "http://host.internal");
  url.searchParams.set("client_name", clientName);
  return `${url.pathname}${url.search}`;
};
