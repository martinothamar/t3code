// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a CI step with only Node built-ins.
/**
 * Signs a prebuilt iOS project for Fork release's TestFlight upload with the App Store profiles and
 * the Apple Distribution certificate, sets the build number and writes the export options. Xcode's
 * own signing would need an App Store Connect key that may manage certificates.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface Profile {
  readonly name: string;
  readonly uuid: string;
  readonly teamId: string;
  readonly bundleId: string;
}

/** The parts of a decoded `.mobileprovision` plist the build needs. */
export function readProfile(plist: unknown): Profile {
  const value = plist as {
    readonly Name?: unknown;
    readonly UUID?: unknown;
    readonly TeamIdentifier?: ReadonlyArray<unknown>;
    readonly Entitlements?: { readonly "application-identifier"?: unknown };
  };
  const teamId = value.TeamIdentifier?.[0];
  const appId = value.Entitlements?.["application-identifier"];
  if (
    typeof value.Name !== "string" ||
    typeof value.UUID !== "string" ||
    typeof teamId !== "string" ||
    typeof appId !== "string" ||
    !appId.startsWith(`${teamId}.`)
  ) {
    throw new Error("Not an iOS provisioning profile.");
  }
  return { name: value.Name, uuid: value.UUID, teamId, bundleId: appId.slice(teamId.length + 1) };
}

const SIGNING_SETTING =
  /^\s*"?(CODE_SIGN_STYLE|CODE_SIGN_IDENTITY|DEVELOPMENT_TEAM|PROVISIONING_PROFILE(_SPECIFIER)?)(\[[^\]]*\])?"? = .*;\n/gm;

/**
 * Signs every Release target that has a bundle identifier manually with its profile. Fails when a
 * target has no profile, or a profile no target: either would fail later, at signing or upload.
 */
export function applyDistributionSigning(
  pbxproj: string,
  profiles: ReadonlyArray<Profile>,
): string {
  const used = new Set<string>();
  const signed = pbxproj.replace(
    /(isa = XCBuildConfiguration;\s*(?:baseConfigurationReference = [^;]*;\s*)?buildSettings = \{\n)((?:(?!\n\s*\};)[\s\S])*)(\n\s*\};\s*name = Release;)/g,
    (block, open: string, settings: string, close: string) => {
      const bundleId = /PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/.exec(settings)?.[1];
      if (bundleId === undefined) return block;
      const profile = profiles.find((candidate) => candidate.bundleId === bundleId);
      if (profile === undefined) throw new Error(`No provisioning profile for ${bundleId}.`);
      used.add(bundleId);
      const indent = /^\s*/.exec(settings)?.[0] ?? "\t\t\t\t";
      const manual = [
        `CODE_SIGN_STYLE = Manual;`,
        `CODE_SIGN_IDENTITY = "Apple Distribution";`,
        `DEVELOPMENT_TEAM = ${profile.teamId};`,
        `PROVISIONING_PROFILE_SPECIFIER = "${profile.name}";`,
      ].map((line) => `${indent}${line}\n`);
      return `${open}${manual.join("")}${`${settings}\n`.replace(SIGNING_SETTING, "").replace(/\n$/, "")}${close}`;
    },
  );
  const unused = profiles.filter((profile) => !used.has(profile.bundleId));
  if (unused.length > 0) {
    throw new Error(`No target uses the profile for ${unused.map((p) => p.bundleId).join(", ")}.`);
  }
  return signed;
}

/** TestFlight needs a build number above every earlier one for the same version. */
export function setBuildNumber(text: string, buildNumber: number): string {
  return text
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`)
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<$]*(<\/string>)/g, `$1${buildNumber}$2`);
}

export function exportOptions(teamId: string, profiles: ReadonlyArray<Profile>): string {
  const entries = profiles
    .map((profile) => `\t\t<key>${profile.bundleId}</key>\n\t\t<string>${profile.name}</string>\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>app-store-connect</string>
\t<key>teamID</key>
\t<string>${teamId}</string>
\t<key>signingStyle</key>
\t<string>manual</string>
\t<key>signingCertificate</key>
\t<string>Apple Distribution</string>
\t<key>provisioningProfiles</key>
\t<dict>
${entries}\t</dict>
\t<key>manageAppVersionAndBuildNumber</key>
\t<false/>
</dict>
</plist>
`;
}

export function parseArguments(args: ReadonlyArray<string>) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Unexpected ${flag}.`);
    values.set(flag.slice(2), value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`--${name} is required.`);
    return value;
  };
  const buildNumber = Number(required("build-number"));
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error("--build-number must be a positive integer.");
  }
  return {
    project: required("project"),
    profiles: required("profiles"),
    buildNumber,
    exportOptions: required("export-options"),
  };
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const installDirectories = [
    NodePath.join(NodeOS.homedir(), "Library/MobileDevice/Provisioning Profiles"),
    NodePath.join(NodeOS.homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
  ];
  const profiles = NodeFS.readdirSync(options.profiles)
    .filter((file) => file.endsWith(".mobileprovision"))
    .map((file) => {
      const path = NodePath.join(options.profiles, file);
      const decoded = NodeChildProcess.execFileSync("security", ["cms", "-D", "-i", path]);
      // The plist's dates and data have no JSON form, so read the strings one at a time.
      const value = (keyPath: string): string | undefined => {
        try {
          return NodeChildProcess.execFileSync(
            "plutil",
            ["-extract", keyPath, "raw", "-o", "-", "-"],
            {
              input: decoded,
              stdio: ["pipe", "pipe", "ignore"],
            },
          )
            .toString("utf8")
            .trimEnd();
        } catch {
          return undefined;
        }
      };
      const profile = readProfile({
        Name: value("Name"),
        UUID: value("UUID"),
        TeamIdentifier: [value("TeamIdentifier.0")],
        Entitlements: { "application-identifier": value("Entitlements.application-identifier") },
      });
      for (const directory of installDirectories) {
        NodeFS.mkdirSync(directory, { recursive: true });
        NodeFS.copyFileSync(path, NodePath.join(directory, `${profile.uuid}.mobileprovision`));
      }
      return profile;
    });
  const teamId = profiles[0]?.teamId;
  if (teamId === undefined) throw new Error(`No .mobileprovision files in ${options.profiles}.`);

  const projects = NodeFS.readdirSync(options.project).filter((name) =>
    name.endsWith(".xcodeproj"),
  );
  if (projects.length !== 1) throw new Error(`Expected one Xcode project in ${options.project}.`);
  const pbxprojPath = NodePath.join(options.project, projects[0]!, "project.pbxproj");
  const pbxproj = NodeFS.readFileSync(pbxprojPath, "utf8");
  NodeFS.writeFileSync(
    pbxprojPath,
    setBuildNumber(applyDistributionSigning(pbxproj, profiles), options.buildNumber),
  );
  for (const entry of NodeFS.readdirSync(options.project, { withFileTypes: true })) {
    const plist = NodePath.join(options.project, entry.name, "Info.plist");
    if (entry.isDirectory() && entry.name !== "Pods" && NodeFS.existsSync(plist)) {
      NodeFS.writeFileSync(
        plist,
        setBuildNumber(NodeFS.readFileSync(plist, "utf8"), options.buildNumber),
      );
    }
  }
  NodeFS.writeFileSync(options.exportOptions, exportOptions(teamId, profiles));
  console.log(
    `Signing ${profiles.map((profile) => profile.bundleId).join(", ")} for team ${teamId}, build ${options.buildNumber}.`,
  );
}

if (import.meta.main) main();
