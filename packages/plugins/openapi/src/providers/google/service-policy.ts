export type GoogleDiscoveryServicePolicy = {
  readonly presetId: string;
  /** Preferred user-consent scopes. Discovery lists alternatives, not a request bundle. */
  readonly consentScopes: readonly string[];
  readonly authoritativeScopes?: Readonly<Record<string, string>>;
  readonly fallbackMethodScopes?: readonly string[];
  readonly blockedMethodIds?: ReadonlySet<string>;
  readonly blockedMethodPrefixes?: readonly string[];
  readonly blockedMethodSubstrings?: readonly string[];
  readonly hiddenParameters?: ReadonlySet<string>;
  readonly requiredParameters?: Readonly<Record<string, ReadonlySet<string>>>;
  readonly requiredRequestBodies?: ReadonlySet<string>;
  readonly hiddenSchemaProperties?: Readonly<Record<string, ReadonlySet<string>>>;
  readonly requiredSchemaProperties?: Readonly<Record<string, ReadonlySet<string>>>;
};

const auth = (scope: string): string => `https://www.googleapis.com/auth/${scope}`;

const GOOGLE_PHOTOS_LIBRARY_SCOPES = {
  [auth("photoslibrary.appendonly")]: "Add photos and videos to Google Photos",
  [auth("photoslibrary.edit.appcreateddata")]: "Edit app-created albums and media in Google Photos",
  [auth("photoslibrary.readonly.appcreateddata")]:
    "Read app-created albums and media in Google Photos",
} as const;

export const googleOAuthConsentScopes: Readonly<Record<string, readonly string[]>> = {
  "google-calendar": [auth("calendar")],
  "google-meet": [
    auth("meetings.space.created"),
    auth("meetings.space.readonly"),
    auth("meetings.space.settings"),
  ],
  "google-gmail": ["https://mail.google.com/", auth("gmail.settings.basic")],
  "google-sheets": [auth("spreadsheets"), auth("drive.file")],
  "google-drive": [auth("drive")],
  "google-docs": [auth("documents")],
  "google-slides": [auth("presentations")],
  "google-forms": [auth("forms.body"), auth("forms.responses.readonly")],
  "google-tasks": [auth("tasks")],
  "google-people": [
    auth("contacts"),
    auth("contacts.other.readonly"),
    auth("directory.readonly"),
    auth("user.addresses.read"),
    auth("user.birthday.read"),
    auth("user.emails.read"),
    auth("user.gender.read"),
    auth("user.organization.read"),
    auth("user.phonenumbers.read"),
  ],
  "google-photos-library": Object.keys(GOOGLE_PHOTOS_LIBRARY_SCOPES),
  "google-photos-picker": [auth("photospicker.mediaitems.readonly")],
  "google-chat": [
    auth("chat.spaces"),
    auth("chat.memberships"),
    auth("chat.messages"),
    auth("chat.customemojis"),
    auth("chat.delete"),
    auth("chat.users.readstate"),
    auth("chat.users.spacesettings"),
    auth("chat.users.sections"),
    auth("chat.users.availability"),
  ],
  // Keep requires Workspace domain-wide delegation and is not placed in the
  // ordinary user-facing catalog. Retain its scope for stored/enterprise data.
  "google-keep": [auth("keep")],
  "google-youtube-data": [auth("youtube.force-ssl"), auth("youtube.channel-memberships.creator")],
  "google-search-console": [auth("webmasters")],
  "google-classroom": [
    auth("classroom.announcements"),
    auth("classroom.courses"),
    auth("classroom.coursework.me"),
    auth("classroom.coursework.students"),
    auth("classroom.courseworkmaterials"),
    auth("classroom.guardianlinks.me.readonly"),
    auth("classroom.guardianlinks.students.readonly"),
    auth("classroom.profile.emails"),
    auth("classroom.profile.photos"),
    auth("classroom.rosters"),
    auth("classroom.topics"),
  ],
  "google-admin-directory": [
    auth("admin.chrome.printers"),
    auth("admin.directory.customer"),
    auth("admin.directory.device.chromeos"),
    auth("admin.directory.device.mobile"),
    auth("admin.directory.domain"),
    auth("admin.directory.group"),
    auth("admin.directory.orgunit"),
    auth("admin.directory.resource.calendar"),
    auth("admin.directory.rolemanagement"),
    auth("admin.directory.user"),
    auth("admin.directory.user.security"),
    auth("admin.directory.userschema"),
  ],
  "google-admin-reports": [
    auth("admin.reports.audit.readonly"),
    auth("admin.reports.usage.readonly"),
  ],
  "google-apps-script": [
    auth("script.projects"),
    auth("script.deployments"),
    auth("script.processes"),
    auth("script.metrics"),
  ],
  "google-bigquery": [auth("bigquery")],
  "google-cloud-resource-manager": [auth("cloud-platform")],
  "google-firebase": [auth("firebase")],
  "google-firestore": [auth("datastore")],
};

export const googleOAuthConsentScopesForPreset = (presetId: string): readonly string[] =>
  googleOAuthConsentScopes[presetId] ?? [];

const policy = (
  presetId: string,
  overrides: Omit<GoogleDiscoveryServicePolicy, "presetId" | "consentScopes"> = {},
): GoogleDiscoveryServicePolicy => ({
  presetId,
  consentScopes: googleOAuthConsentScopesForPreset(presetId),
  ...overrides,
});

const GOOGLE_DISCOVERY_POLICIES: Readonly<Record<string, GoogleDiscoveryServicePolicy>> = {
  "calendar/v3": policy("google-calendar", {
    blockedMethodIds: new Set(["calendar.calendars.transferOwnership"]),
  }),
  "meet/v2": policy("google-meet"),
  "gmail/v1": policy("google-gmail", {
    blockedMethodPrefixes: ["gmail.users.settings.delegates."],
  }),
  "sheets/v4": policy("google-sheets", {
    hiddenSchemaProperties: {
      Request: new Set([
        "addDataSource",
        "updateDataSource",
        "refreshDataSource",
        "cancelDataSourceRefresh",
      ]),
    },
  }),
  "drive/v3": policy("google-drive", {
    blockedMethodIds: new Set(["drive.apps.list"]),
  }),
  "docs/v1": policy("google-docs"),
  "slides/v1": policy("google-slides"),
  "forms/v1": policy("google-forms"),
  "tasks/v1": policy("google-tasks"),
  "people/v1": policy("google-people", {
    requiredParameters: {
      "people.people.createContact": new Set(["personFields"]),
      "people.people.get": new Set(["personFields"]),
      "people.people.getBatchGet": new Set(["resourceNames", "personFields"]),
      "people.people.connections.list": new Set(["personFields"]),
      "people.people.searchContacts": new Set(["query", "readMask"]),
      "people.people.updateContact": new Set(["updatePersonFields"]),
      "people.people.listDirectoryPeople": new Set(["sources", "readMask"]),
      "people.people.searchDirectoryPeople": new Set(["query", "sources", "readMask"]),
      "people.otherContacts.list": new Set(["readMask"]),
      "people.otherContacts.search": new Set(["query", "readMask"]),
      "people.contactGroups.batchGet": new Set(["resourceNames"]),
    },
    requiredRequestBodies: new Set([
      "people.people.createContact",
      "people.people.batchCreateContacts",
      "people.people.batchUpdateContacts",
      "people.people.batchDeleteContacts",
      "people.people.updateContact",
      "people.people.updateContactPhoto",
      "people.contactGroups.create",
      "people.contactGroups.update",
      "people.contactGroups.members.modify",
      "people.otherContacts.copyOtherContactToMyContactsGroup",
    ]),
    requiredSchemaProperties: {
      BatchCreateContactsRequest: new Set(["contacts", "readMask"]),
      BatchUpdateContactsRequest: new Set(["contacts", "updateMask", "readMask"]),
      BatchDeleteContactsRequest: new Set(["resourceNames"]),
      UpdateContactPhotoRequest: new Set(["photoBytes"]),
      CreateContactGroupRequest: new Set(["contactGroup"]),
      UpdateContactGroupRequest: new Set(["contactGroup"]),
      CopyOtherContactToMyContactsGroupRequest: new Set(["copyMask"]),
    },
  }),
  "photoslibrary/v1": policy("google-photos-library", {
    authoritativeScopes: GOOGLE_PHOTOS_LIBRARY_SCOPES,
    blockedMethodIds: new Set([
      "photoslibrary.albums.share",
      "photoslibrary.albums.unshare",
      "photoslibrary.sharedAlbums.get",
      "photoslibrary.sharedAlbums.join",
      "photoslibrary.sharedAlbums.leave",
      "photoslibrary.sharedAlbums.list",
    ]),
  }),
  "photospicker/v1": policy("google-photos-picker", {
    authoritativeScopes: {
      [auth("photospicker.mediaitems.readonly")]: "Read selected Google Photos media",
    },
    fallbackMethodScopes: [auth("photospicker.mediaitems.readonly")],
    hiddenParameters: new Set(["access_token", "oauth_token", "key"]),
    requiredParameters: {
      "photospicker.mediaItems.list": new Set(["sessionId"]),
    },
    hiddenSchemaProperties: {
      PickingConfig: new Set(["showEducationBanner", "showZeroState", "showExpandedAppBar"]),
    },
  }),
  "chat/v1": policy("google-chat", {
    blockedMethodIds: new Set([
      "chat.spaces.completeImport",
      "chat.spaces.messages.attachments.get",
    ]),
  }),
  // Keep is intentionally not given an inferred ordinary-user consent set.
  "keep/v1": { ...policy("google-keep"), consentScopes: [] },
  "youtube/v3": policy("google-youtube-data", {
    blockedMethodIds: new Set(["youtube.abuseReports.insert", "youtube.tests.insert"]),
    blockedMethodPrefixes: ["youtube.thirdPartyLinks."],
    hiddenParameters: new Set([
      "onBehalfOfContentOwner",
      "onBehalfOfContentOwnerChannel",
      "managedByMe",
      "forContentOwner",
    ]),
  }),
  "searchconsole/v1": policy("google-search-console"),
  "classroom/v1": policy("google-classroom", {
    blockedMethodIds: new Set(["classroom.courses.teachers.create"]),
    blockedMethodPrefixes: ["classroom.courses.studentGroups.", "classroom.courses.posts."],
    blockedMethodSubstrings: [".addOnAttachments.", ".getAddOnContext"],
  }),
  "admin/directory_v1": policy("google-admin-directory", {
    blockedMethodIds: new Set(["directory.chromeosdevices.action"]),
  }),
  "admin/reports_v1": policy("google-admin-reports"),
  "script/v1": policy("google-apps-script", {
    blockedMethodIds: new Set(["script.scripts.run"]),
  }),
  "bigquery/v2": policy("google-bigquery"),
  "cloudresourcemanager/v3": policy("google-cloud-resource-manager"),
  "firebase/v1beta1": policy("google-firebase"),
  "firestore/v1": policy("google-firestore"),
};

export const googleDiscoveryPolicyFor = (
  service: string,
  version: string,
): GoogleDiscoveryServicePolicy | undefined => GOOGLE_DISCOVERY_POLICIES[`${service}/${version}`];

export const isGoogleDiscoveryMethodAllowed = (
  policyValue: GoogleDiscoveryServicePolicy | undefined,
  methodId: string,
): boolean => {
  if (!policyValue) return true;
  if (policyValue.blockedMethodIds?.has(methodId)) return false;
  if (policyValue.blockedMethodPrefixes?.some((prefix) => methodId.startsWith(prefix)))
    return false;
  if (policyValue.blockedMethodSubstrings?.some((part) => methodId.includes(part))) return false;
  return true;
};
