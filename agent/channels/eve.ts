import { parseActor, serializeActor } from "@open-agents/authz";
import type { SessionAuthContext } from "eve/context";
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { auth } from "../../apps/open-agents/lib/auth/config";

const localDevAuth = localDev();

function getHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value ? value : undefined;
}

export function withOpenAgentsRequestAttributes(
  auth: AuthFn<Request>,
  options: { trustOpenAgentsUserHeader?: boolean } = {},
): AuthFn<Request> {
  return async (request) => {
    const sessionAuth = await auth(request);
    if (!sessionAuth) {
      return null;
    }

    const openAgentsActorHeader = getHeader(request, "x-open-agents-user-id");
    const authenticatedUserId = sessionAuth.subject ?? sessionAuth.principalId;
    const authenticatedActorId = serializeActor({ kind: "user", userId: authenticatedUserId });
    const requestedActor = openAgentsActorHeader ? parseActor(openAgentsActorHeader) : undefined;

    if (
      requestedActor &&
      !options.trustOpenAgentsUserHeader &&
      (requestedActor.kind !== "user" || requestedActor.userId !== authenticatedUserId)
    ) {
      return null;
    }

    const actorId =
      options.trustOpenAgentsUserHeader && requestedActor
        ? serializeActor(requestedActor)
        : authenticatedActorId;

    return {
      ...sessionAuth,
      subject: actorId,
      attributes: {
        ...sessionAuth.attributes,
        openAgentsActor: actorId,
        openAgentsUserId: actorId,
        ...(getHeader(request, "x-open-agents-session-id")
          ? { openAgentsSessionId: getHeader(request, "x-open-agents-session-id")! }
          : {}),
        ...(getHeader(request, "x-open-agents-chat-id")
          ? { openAgentsChatId: getHeader(request, "x-open-agents-chat-id")! }
          : {}),
        ...(getHeader(request, "x-open-agents-tool-profile")
          ? { openAgentsToolProfile: getHeader(request, "x-open-agents-tool-profile")! }
          : {}),
      },
    } satisfies SessionAuthContext;
  };
}

function openAgentsLocalSession(): AuthFn<Request> {
  return async (request) => {
    if (process.env.NODE_ENV === "production" || process.env.OPEN_AGENTS_AUTH_MODE !== "local") {
      return null;
    }

    const localDevSession = await localDevAuth(request);

    if (!localDevSession) {
      return null;
    }

    const userId = process.env.OPEN_AGENTS_LOCAL_USER_ID || "local-user";
    const username = process.env.OPEN_AGENTS_LOCAL_USERNAME || "local-user";

    return {
      attributes: {
        email: process.env.OPEN_AGENTS_LOCAL_EMAIL || "local@vercel.com",
        name: process.env.OPEN_AGENTS_LOCAL_NAME || "Local User",
        username,
      },
      authenticator: "open-agents",
      principalId: userId,
      principalType: "user",
      subject: userId,
    };
  };
}

type OpenAgentsAuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
type OpenAgentsAuthUser = OpenAgentsAuthSession["user"];

function toUserAttributes(user: OpenAgentsAuthUser): SessionAuthContext["attributes"] {
  return {
    email: user.email,
    name: user.name,
    username: user.username,
  };
}

function openAgentsWebSession(): AuthFn<Request> {
  return async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session) {
      return null;
    }

    return {
      attributes: toUserAttributes(session.user),
      authenticator: "open-agents-web",
      principalId: session.user.id,
      principalType: "user",
      subject: session.user.id,
    };
  };
}

export default eveChannel({
  auth: [
    withOpenAgentsRequestAttributes(openAgentsLocalSession()),
    withOpenAgentsRequestAttributes(openAgentsWebSession()),
    withOpenAgentsRequestAttributes(vercelOidc(), { trustOpenAgentsUserHeader: true }),
    withOpenAgentsRequestAttributes(localDev(), { trustOpenAgentsUserHeader: true }),
  ],
});
