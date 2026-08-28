import { expect, it } from "@effect/vitest";

import { googleDiscoveryPolicyFor, isGoogleDiscoveryMethodAllowed } from "./service-policy";

const allowed = (service: string, version: string, methodId: string): boolean =>
  isGoogleDiscoveryMethodAllowed(googleDiscoveryPolicyFor(service, version), methodId);

it("separates methods that require a different Google credential or product mode", () => {
  expect(allowed("gmail", "v1", "gmail.users.settings.delegates.list")).toBe(false);
  expect(allowed("calendar", "v3", "calendar.calendars.transferOwnership")).toBe(false);
  expect(allowed("drive", "v3", "drive.apps.list")).toBe(false);
  expect(allowed("chat", "v1", "chat.spaces.completeImport")).toBe(false);
  expect(allowed("chat", "v1", "chat.spaces.messages.attachments.get")).toBe(false);
  expect(allowed("classroom", "v1", "classroom.courses.teachers.create")).toBe(false);
  expect(allowed("classroom", "v1", "classroom.courses.courseWork.addOnAttachments.create")).toBe(
    false,
  );
  expect(allowed("youtube", "v3", "youtube.thirdPartyLinks.list")).toBe(false);
  expect(allowed("admin", "directory_v1", "directory.chromeosdevices.action")).toBe(false);
  expect(allowed("script", "v1", "script.scripts.run")).toBe(false);
});

it("removes retired Google Photos sharing methods while retaining supported actions", () => {
  expect(allowed("photoslibrary", "v1", "photoslibrary.sharedAlbums.list")).toBe(false);
  expect(allowed("photoslibrary", "v1", "photoslibrary.albums.share")).toBe(false);
  expect(allowed("photoslibrary", "v1", "photoslibrary.mediaItems.batchCreate")).toBe(true);
  expect(allowed("photoslibrary", "v1", "photoslibrary.albums.batchRemoveMediaItems")).toBe(true);
});

it("does not infer ordinary user OAuth for Google Keep", () => {
  expect(googleDiscoveryPolicyFor("keep", "v1")?.consentScopes).toEqual([]);
});
