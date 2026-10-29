/** Create a platform package version below its matching CLI wrapper version.
 *
 * @param version - The installable wrapper's SemVer version.
 * @param platform - The platform identifier appended to the wrapper release.
 * @returns A prerelease version that package managers rank below the wrapper.
 */
export const platformVariantVersion = (version: string, platform: string): string => {
  const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null || match[1] === undefined) {
    throw new Error(`Invalid Executor package version for platform variant: ${version}`);
  }

  const baseVersion = match[1];
  const prerelease = match[2];
  const build = match[3];
  return `${baseVersion}-0${prerelease === undefined ? "" : `.${prerelease}`}.${platform}${build === undefined ? "" : `+${build}`}`;
};
