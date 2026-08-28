const googleUserConsentBlockedScopes = new Set([
  "https://www.googleapis.com/auth/chat.bot",
  "https://www.googleapis.com/auth/chat.import",
  // Gmail sharing-setting writes require a service account with domain-wide
  // delegation, not the authorization-code flow used by user connections.
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/keep",
  "https://www.googleapis.com/auth/keep.readonly",
]);

const googleUserConsentBlockedScopePrefixes = [
  "https://www.googleapis.com/auth/chat.app.",
  // Contextual Calendar add-on scopes are minted for add-on executions.
  "https://www.googleapis.com/auth/calendar.addons.",
  // Contextual Gmail add-on scopes are minted for add-on executions, not a
  // standalone web OAuth connection.
  "https://www.googleapis.com/auth/gmail.addons.",
];

const googleMailScopesCoveredByFullAccess = new Set([
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
]);

const auth = (scope: string): string => `https://www.googleapis.com/auth/${scope}`;

const googleDriveScopesCoveredByFullAccess = new Set([
  auth("drive.appdata"),
  auth("drive.file"),
  auth("drive.meet.readonly"),
  auth("drive.metadata"),
  auth("drive.metadata.readonly"),
  auth("drive.photos.readonly"),
  auth("drive.readonly"),
  auth("drive.scripts"),
]);

const exactBroadScopeGroups: Readonly<Record<string, ReadonlySet<string>>> = {
  [auth("documents")]: new Set([auth("documents.readonly")]),
  [auth("presentations")]: new Set([auth("presentations.readonly")]),
  [auth("spreadsheets")]: new Set([auth("spreadsheets.readonly")]),
  [auth("forms.body")]: new Set([auth("forms.body.readonly")]),
  [auth("tasks")]: new Set([auth("tasks.readonly")]),
  [auth("contacts")]: new Set([auth("contacts.readonly")]),
  [auth("chat.spaces")]: new Set([auth("chat.spaces.readonly")]),
  [auth("chat.memberships")]: new Set([auth("chat.memberships.readonly")]),
  [auth("chat.messages")]: new Set([auth("chat.messages.readonly")]),
  [auth("chat.customemojis")]: new Set([auth("chat.customemojis.readonly")]),
  [auth("webmasters")]: new Set([auth("webmasters.readonly")]),
  [auth("cloud-platform")]: new Set([auth("cloud-platform.read-only")]),
  [auth("script.projects")]: new Set([auth("script.projects.readonly")]),
  [auth("script.deployments")]: new Set([auth("script.deployments.readonly")]),
  [auth("classroom.announcements")]: new Set([auth("classroom.announcements.readonly")]),
  [auth("classroom.courses")]: new Set([auth("classroom.courses.readonly")]),
  [auth("classroom.coursework.me")]: new Set([
    auth("classroom.coursework.me.readonly"),
    auth("classroom.student-submissions.me.readonly"),
  ]),
  [auth("classroom.coursework.students")]: new Set([
    auth("classroom.coursework.students.readonly"),
    auth("classroom.student-submissions.students.readonly"),
  ]),
  [auth("classroom.courseworkmaterials")]: new Set([
    auth("classroom.courseworkmaterials.readonly"),
  ]),
  [auth("classroom.rosters")]: new Set([auth("classroom.rosters.readonly")]),
  [auth("classroom.topics")]: new Set([auth("classroom.topics.readonly")]),
  [auth("admin.chrome.printers")]: new Set([auth("admin.chrome.printers.readonly")]),
  [auth("admin.directory.customer")]: new Set([auth("admin.directory.customer.readonly")]),
  [auth("admin.directory.device.chromeos")]: new Set([
    auth("admin.directory.device.chromeos.readonly"),
  ]),
  [auth("admin.directory.device.mobile")]: new Set([
    auth("admin.directory.device.mobile.action"),
    auth("admin.directory.device.mobile.readonly"),
  ]),
  [auth("admin.directory.domain")]: new Set([auth("admin.directory.domain.readonly")]),
  [auth("admin.directory.group")]: new Set([
    auth("admin.directory.group.readonly"),
    auth("admin.directory.group.member"),
    auth("admin.directory.group.member.readonly"),
  ]),
  [auth("admin.directory.orgunit")]: new Set([auth("admin.directory.orgunit.readonly")]),
  [auth("admin.directory.resource.calendar")]: new Set([
    auth("admin.directory.resource.calendar.readonly"),
  ]),
  [auth("admin.directory.rolemanagement")]: new Set([
    auth("admin.directory.rolemanagement.readonly"),
  ]),
  [auth("admin.directory.user")]: new Set([
    auth("admin.directory.user.alias"),
    auth("admin.directory.user.alias.readonly"),
    auth("admin.directory.user.readonly"),
  ]),
  [auth("admin.directory.userschema")]: new Set([auth("admin.directory.userschema.readonly")]),
};

const googleBroadScopeGroups: readonly {
  readonly broad: string;
  readonly covers: (scope: string) => boolean;
}[] = [
  {
    broad: "https://mail.google.com/",
    // Full mailbox access covers message, draft, label, and send operations,
    // but Google requires gmail.settings.basic separately for filter writes.
    covers: (scope) => googleMailScopesCoveredByFullAccess.has(scope),
  },
  {
    broad: "https://www.googleapis.com/auth/calendar",
    covers: (scope) => scope.startsWith("https://www.googleapis.com/auth/calendar."),
  },
  {
    broad: "https://www.googleapis.com/auth/drive",
    // Do not swallow independent scopes such as drive.apps.readonly,
    // drive.activity, drive.install, or future drive.* scopes.
    covers: (scope) => googleDriveScopesCoveredByFullAccess.has(scope),
  },
  ...Object.entries(exactBroadScopeGroups).map(([broad, covered]) => ({
    broad,
    covers: (scope: string) => covered.has(scope),
  })),
];

const normalizeGoogleIdentityScope = (scope: string): string =>
  scope === "https://www.googleapis.com/auth/userinfo.email"
    ? "email"
    : scope === "https://www.googleapis.com/auth/userinfo.profile"
      ? "profile"
      : scope;

const orderedUniqueScopes = (scopes: Iterable<string>): string[] => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
};

export const isGoogleUserConsentOAuthScope = (scope: string): boolean =>
  !googleUserConsentBlockedScopes.has(scope) &&
  !googleUserConsentBlockedScopePrefixes.some((prefix) => scope.startsWith(prefix));

export const filterGoogleUserConsentOAuthScopes = (scopes: Iterable<string>): string[] =>
  orderedUniqueScopes(scopes).filter(isGoogleUserConsentOAuthScope);

export const compactGoogleOAuthScopes = (scopes: Iterable<string>): string[] => {
  const ordered = filterGoogleUserConsentOAuthScopes([...scopes].map(normalizeGoogleIdentityScope));
  const present = new Set(ordered);
  return ordered.filter(
    (scope) =>
      !googleBroadScopeGroups.some(
        (group) => scope !== group.broad && present.has(group.broad) && group.covers(scope),
      ),
  );
};
