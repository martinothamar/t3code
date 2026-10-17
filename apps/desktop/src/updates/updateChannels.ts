import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;

// Preview builds are packaged with the stable product name and icons (see
// resolveDesktopProductName in scripts/build-desktop-artifact.ts), so they are
// branded Beta at runtime too, rather than Nightly in a Beta-named app.
export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
