export const signInOriginCookie = "executor_sign_in_origin";

export const signInOriginSeconds = 30 * 60;

export type SignInOrigin = "mcp_authorize" | "device" | "web";

export const signInOriginOf = (redirect: string): SignInOrigin => {
  const path = redirect.split(/[?#]/u, 1)[0];
  return path === "/mcp/authorize" ? "mcp_authorize" : path === "/device" ? "device" : "web";
};

export const readSignInOrigin = (cookies: string): SignInOrigin => {
  const value = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${signInOriginCookie}=`))
    ?.slice(signInOriginCookie.length + 1);
  return value === "mcp_authorize" || value === "device" ? value : "web";
};
