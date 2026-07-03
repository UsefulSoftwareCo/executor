export class GitHubInstallationsSyncError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(
    message: string,
    options: { status: number; responseText: string },
  ) {
    super(message);
    this.name = "GitHubInstallationsSyncError";
    this.status = options.status;
    this.responseText = options.responseText;
  }
}

const GITHUB_403_AUTH_ERROR_PATTERNS = [
  "bad credentials",
  "oauth access token has expired",
  "oauth token has expired",
  "this token has expired",
  "token is expired",
  "token is invalid",
  "token was revoked",
  "requires authentication",
  "must grant your oauth app access",
];

function isGitHubInstallations403AuthError(responseText: string): boolean {
  const normalizedResponseText = responseText.toLowerCase();

  return GITHUB_403_AUTH_ERROR_PATTERNS.some((pattern) =>
    normalizedResponseText.includes(pattern),
  );
}

export function isGitHubInstallationsAuthError(error: unknown): boolean {
  if (error instanceof GitHubInstallationsSyncError) {
    if (error.status === 401) {
      return true;
    }

    if (error.status === 403) {
      return isGitHubInstallations403AuthError(error.responseText);
    }

    return false;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return (
    normalizedMessage.includes(" 401 ") ||
    (normalizedMessage.includes(" 403 ") &&
      isGitHubInstallations403AuthError(normalizedMessage))
  );
}
