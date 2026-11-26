import {
  signInOriginCookie,
  signInOriginOf,
  signInOriginSeconds,
} from "@executor-js/hosted-server/sign-in-origin";

const attributes = () =>
  `Path=/; ${window.location.protocol === "https:" ? "SameSite=None; Secure" : "SameSite=Lax"}`;

export const rememberSignInOrigin = (redirect: string): void => {
  const origin = signInOriginOf(redirect);
  document.cookie =
    origin === "web"
      ? `${signInOriginCookie}=; Max-Age=0; ${attributes()}`
      : `${signInOriginCookie}=${origin}; Max-Age=${signInOriginSeconds}; ${attributes()}`;
};
