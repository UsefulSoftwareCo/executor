import { defineProvider, oauth2 } from "apps";

export const github = defineProvider({
  name: "GitHub",
  auth: {
    oauth: oauth2({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
    }),
  },
});

export const gmail = defineProvider({
  name: "Gmail",
  auth: {
    oauth: oauth2({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    }),
  },
});
