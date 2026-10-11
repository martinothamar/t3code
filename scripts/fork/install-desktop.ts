// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Builds the fork's desktop app from the checked-out ref and installs it for
 * the current user, on Linux, macOS and Windows:
 *
 *   node scripts/fork/install-desktop.ts
 *
 * The build is stamped with the newest upstream nightly reachable from HEAD,
 * because SSH hosts install the server release matching the app's version.
 * See docs/operations/fork-desktop-build.md.
 */
import type { CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
const platform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
const arch = process.arch;

const DIST_TARGETS: Partial<Record<NodeJS.Platform, { script: string; extension: string }>> = {
  linux: { script: "dist:desktop:linux", extension: ".AppImage" },
  darwin: { script: "dist:desktop:dmg", extension: ".dmg" },
  win32: { script: "dist:desktop:win", extension: ".exe" },
};

// SSH hosts pick the archive for their own platform (packages/ssh/src/tunnel.ts),
// whatever the client runs on, so every build needs all of them. Upstream
// publishes no darwin-x64 archive.
const SERVER_ARCHIVE_PLATFORM_KEYS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
] as const satisfies ReadonlyArray<CliArchivePlatformKey>;

// Of the build's own T3CODE_DESKTOP_* options only the version is passed on;
// others move its output, skip it or add an update feed. CARGO_TARGET_DIR moves
// cargo output away from the path the build copies native helpers from.
// GITHUB_REPOSITORY gives the build an update feed, and the app would then
// replace itself with an upstream build. Without a feed, a publish token makes
// electron-builder fall back to a publish provider it cannot resolve, and the
// build fails writing update info.
const REMOVED_BUILD_ENV = new Set([
  "CARGO_TARGET_DIR",
  "GITHUB_REPOSITORY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "KEYGEN_TOKEN",
  "BITBUCKET_TOKEN",
]);

// Homebrew casks and the app bundle each one installs into /Applications.
const UPSTREAM_CASKS: Record<string, string> = {
  "t3-code": "T3 Code (Alpha).app",
  "t3-code@nightly": "T3 Code (Nightly).app",
};

class InstallError extends Error {}

function fail(message: string): never {
  throw new InstallError(message);
}

function log(message: string): void {
  console.log(`[install-desktop] ${message}`);
}

/** The build's environment: the version set, and nothing that moves output or adds an update feed. */
export function buildEnvironment(env: NodeJS.ProcessEnv, version: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    // Windows environment names are case-insensitive.
    const name = key.toUpperCase();
    if (name.startsWith("T3CODE_DESKTOP_") || REMOVED_BUILD_ENV.has(name)) continue;
    result[key] = value;
  }
  result.T3CODE_DESKTOP_VERSION = version;
  return result;
}

/** The untranslated `Name` of a .desktop file's `[Desktop Entry]` group. */
export function parseDesktopEntryName(text: string): string | undefined {
  let inEntry = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
    } else if (inEntry && /^Name\s*=/.test(line)) {
      return line.slice(line.indexOf("=") + 1).trim();
    }
  }
  return undefined;
}

// Matches the escaping in apps/desktop/src/app/DesktopLinuxUrlHandler.ts: Exec
// arguments are quoted, then the general string escaping applies on top.
function escapeDesktopEntryString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

function escapeDesktopEntryExecArgument(value: string): string {
  if (/^[\w./+@:,-]+$/.test(value)) return value;
  const quoted = value.replace(/[\\`$"]/g, (char) => `\\${char}`).replaceAll("%", "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

/** The launcher at ~/.local/share/applications/t3code.desktop. */
export function renderLauncher(input: {
  name: string;
  execPath: string;
  iconPath: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.name)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execPath)} %U`,
    `Icon=${escapeDesktopEntryString(input.iconPath)}`,
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=t3code",
    "",
  ].join("\n");
}

function git(args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout.trim();
}

// `shell` resolves `vp` through PATH, including Windows command shims.
function runVp(command: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = NodeChildProcess.spawnSync(`vp ${command}`, {
    cwd: repoRoot,
    env,
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`vp ${command} exited with code ${result.status ?? "unknown"}.`);
}

function run(command: string, args: ReadonlyArray<string>, cwd = repoRoot): void {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status ?? "unknown"}.`);
}

function succeeds(command: string, args: ReadonlyArray<string>): string | undefined {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function resolveVersion(): string {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["describe", "--tags", "--abbrev=0", "--match", "v*-nightly.*"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(
      "No upstream nightly tag is reachable from HEAD. Fetch upstream's tags with " +
        "`git fetch upstream --tags` and run again.",
    );
  }
  return result.stdout.trim().replace(/^v/, "");
}

async function assertServerArchivesPublished(version: string): Promise<void> {
  const { cliArchiveFileName, cliReleaseDownloadBaseUrl } =
    await import("@t3tools/shared/cliRelease");
  const baseUrl = cliReleaseDownloadBaseUrl(version);
  const missing: Array<string> = [];
  await Promise.all(
    SERVER_ARCHIVE_PLATFORM_KEYS.map(async (key) => {
      const fileName = cliArchiveFileName(version, key);
      const url = `${baseUrl}/${fileName}`;
      const response = await fetch(url, { method: "HEAD" }).catch((error: unknown) =>
        fail(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`),
      );
      if (!response.ok) missing.push(`${fileName} (HTTP ${response.status})`);
    }),
  );
  if (missing.length > 0) {
    fail(
      `Upstream release v${version} lacks server archives SSH hosts install:\n` +
        missing.map((name) => `  ${name}`).join("\n"),
    );
  }
  log(`Upstream publishes the v${version} server archives.`);
}

function restoreTrackedFiles(): void {
  const changed = git(["diff", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
  if (changed.length === 0) return;
  git(["checkout", "HEAD", "--", ...changed]);
  log(
    `Restored tracked files the build changed:\n${changed.map((file) => `  ${file}`).join("\n")}`,
  );
}

function findArtifact(version: string, extension: string): string {
  const releaseDir = NodePath.join(repoRoot, "release");
  const [newest] = NodeFS.readdirSync(releaseDir)
    .filter((name) => name.startsWith(`T3-Code-${version}-`) && name.endsWith(extension))
    .map((name) => NodePath.join(releaseDir, name))
    .map((path) => ({ path, mtimeMs: NodeFS.statSync(path).mtimeMs }))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  if (!newest) {
    fail(`The build wrote no T3-Code-${version}-*${extension} to ${releaseDir}.`);
  }
  return newest.path;
}

/** Writes next to the destination and renames over it, so a running copy keeps its file. */
function replace(destination: string, write: (staged: string) => void): void {
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  const staged = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.installing-${process.pid}`,
  );
  try {
    write(staged);
    NodeFS.renameSync(staged, destination);
  } catch (error) {
    NodeFS.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function installFile(source: string, destination: string, mode: number): void {
  replace(destination, (staged) => {
    NodeFS.copyFileSync(source, staged);
    NodeFS.chmodSync(staged, mode);
  });
}

function installLinux(appImage: string): void {
  const home = NodeOS.homedir();
  const execPath = NodePath.join(home, ".local", "bin", "t3code");
  const iconPath = NodePath.join(home, ".local", "share", "icons", "t3code.png");
  const applicationsDir = NodePath.join(home, ".local", "share", "applications");
  const launcherPath = NodePath.join(applicationsDir, "t3code.desktop");

  const extractDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-install-"));
  try {
    const extract = (path: string) => run(appImage, ["--appimage-extract", path], extractDir);
    const root = NodePath.join(extractDir, "squashfs-root");
    const dirIcon = NodePath.join(root, ".DirIcon");
    extract("*.desktop");
    extract(".DirIcon");
    if (NodeFS.lstatSync(dirIcon).isSymbolicLink()) extract(NodeFS.readlinkSync(dirIcon));
    const entry = NodeFS.readdirSync(root).find((file) => file.endsWith(".desktop"));
    const name = entry
      ? parseDesktopEntryName(NodeFS.readFileSync(NodePath.join(root, entry), "utf8"))
      : undefined;
    if (!name) fail(`${appImage} has no desktop entry with a Name.`);
    installFile(NodeFS.realpathSync(dirIcon), iconPath, 0o644);
    installFile(appImage, execPath, 0o755);
    replace(launcherPath, (staged) =>
      NodeFS.writeFileSync(staged, renderLauncher({ name, execPath, iconPath }), { mode: 0o644 }),
    );
    log(`Installed ${name}:\n  ${execPath}\n  ${launcherPath}\n  ${iconPath}`);
  } finally {
    NodeFS.rmSync(extractDir, { recursive: true, force: true });
  }
  if (succeeds("update-desktop-database", [applicationsDir]) === undefined) {
    log("update-desktop-database is unavailable or failed; skipped refreshing the desktop cache.");
  }
}

function installMac(dmg: string): void {
  const applicationsDir = NodePath.join(NodeOS.homedir(), "Applications");
  const mountPoint = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-dmg-"));
  run("hdiutil", [
    "attach",
    dmg,
    "-nobrowse",
    "-readonly",
    "-noautoopen",
    "-mountpoint",
    mountPoint,
  ]);
  try {
    const app = NodeFS.readdirSync(mountPoint, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    );
    if (!app) fail(`${dmg} contains no .app.`);
    const target = NodePath.join(applicationsDir, app.name);
    replace(target, (staged) => {
      // ditto keeps the bundle's symlinks, extended attributes and signature intact.
      run("ditto", [NodePath.join(mountPoint, app.name), staged]);
      NodeFS.rmSync(target, { recursive: true, force: true });
    });
    log(`Installed ${target}`);
  } finally {
    const detach = (...flags: Array<string>) =>
      NodeChildProcess.spawnSync("hdiutil", ["detach", ...flags, mountPoint], { stdio: "ignore" })
        .status === 0;
    if (detach() || detach("-force")) NodeFS.rmdirSync(mountPoint);
    else log(`Could not detach ${mountPoint}; eject it in Finder.`);
  }
}

function installWindows(installer: string): void {
  // The NSIS installer installs per user; /S runs it without a window.
  run(installer, ["/S"]);
  log(`Installed ${NodePath.basename(installer)}.`);
}

/** Removal instructions for upstream installs, which update themselves to upstream builds. */
function findUpstreamInstalls(): Array<string> {
  if (platform === "linux") {
    const hints: Array<string> = [];
    for (const pkg of ["t3code-bin", "t3code-nightly-bin"]) {
      if (succeeds("pacman", ["-Q", pkg]) !== undefined) {
        hints.push(`${pkg} (AUR): sudo pacman -R ${pkg}`);
      }
    }
    if (
      succeeds("dpkg-query", ["-W", "-f", "${db:Status-Status}", "t3code"])?.trim() === "installed"
    ) {
      hints.push("t3code (.deb): sudo apt remove t3code");
    }
    return hints;
  }

  if (platform === "darwin") {
    const installedCasks = new Set(succeeds("brew", ["list", "--cask", "-1"])?.split("\n"));
    const casks = Object.keys(UPSTREAM_CASKS).filter((cask) => installedCasks.has(cask));
    const caskApps = new Set(casks.map((cask) => UPSTREAM_CASKS[cask]));
    // Upstream builds ship an update feed; the fork's build has none.
    const apps = NodeFS.readdirSync("/Applications").filter(
      (app) =>
        app.startsWith("T3 Code") &&
        !caskApps.has(app) &&
        NodeFS.existsSync(NodePath.join("/Applications", app, "Contents/Resources/app-update.yml")),
    );
    return [
      // A cask's zap stanza deletes ~/.t3/userdata, so never suggest --zap.
      ...casks.map((cask) => `${cask} (Homebrew): brew uninstall --cask ${cask}`),
      ...apps.map((app) => `/Applications/${app}: move it to the Trash`),
    ];
  }

  if (platform === "win32") {
    const keys = ["HKCU:\\Software", "HKLM:\\Software", "HKLM:\\Software\\WOW6432Node"]
      .map((root) => `'${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'`)
      .join(",");
    const output = succeeds("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `ConvertTo-Json -Compress -InputObject @(Get-ItemProperty ${keys} -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.DisplayName -like 'T3 Code*' } | Select-Object DisplayName, UninstallString)`,
    ]);
    let entries: Array<{ DisplayName?: string; UninstallString?: string }> = [];
    try {
      entries = output ? JSON.parse(output) : [];
    } catch {
      log("Could not read the installed apps from the registry; skipped looking for upstream.");
    }
    return entries.flatMap(({ DisplayName, UninstallString }) => {
      const uninstaller = /^"([^"]+)"/.exec(UninstallString ?? "")?.[1];
      if (!uninstaller) return [];
      const updateFeed = NodePath.join(
        NodePath.dirname(uninstaller),
        "resources",
        "app-update.yml",
      );
      if (!NodeFS.existsSync(updateFeed)) return [];
      return [
        `${DisplayName}: uninstall it in Settings > Apps > Installed apps, or run ${UninstallString}`,
      ];
    });
  }

  return [];
}

async function main(): Promise<void> {
  const target = DIST_TARGETS[platform];
  if (!target) fail(`There is no desktop build for ${platform}.`);
  if (platform === "linux" && arch !== "x64") {
    fail(`The Linux desktop build (${target.script}) is x64 only; this host is ${arch}.`);
  }
  if (git(["status", "--porcelain"]) !== "") {
    fail(
      "The working tree has uncommitted changes. Commit or stash them, so the build matches a ref.",
    );
  }
  const version = resolveVersion();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(["rev-parse", "--short", "HEAD"]);
  log(`Building ${branch === "HEAD" ? commit : `${branch} at ${commit}`} as ${version}.`);

  const upstream = findUpstreamInstalls()
    .map((hint) => `  ${hint}`)
    .join("\n");
  // The fork's NSIS installer shares upstream's app ID, so it would uninstall
  // a per-user upstream install before installing.
  if (platform === "win32" && upstream) {
    fail(
      `Upstream T3 Code is installed, and the fork's installer could replace it. Remove it first:\n${upstream}`,
    );
  }

  runVp("i");
  await assertServerArchivesPublished(version);

  // Ctrl+C also reaches the build; ignoring it here lets the restore run.
  const ignoreInterrupt = () => {};
  process.on("SIGINT", ignoreInterrupt);
  try {
    runVp(`run ${target.script}`, buildEnvironment(process.env, version));
  } finally {
    process.off("SIGINT", ignoreInterrupt);
    restoreTrackedFiles();
  }
  const artifact = findArtifact(version, target.extension);
  log(`Built ${NodePath.relative(repoRoot, artifact)}.`);

  if (platform === "linux") installLinux(artifact);
  else if (platform === "darwin") installMac(artifact);
  else installWindows(artifact);

  if (upstream) {
    log(
      "Upstream T3 Code is also installed and updates itself to upstream builds. " +
        `This script leaves it alone; remove it yourself if you want only the fork:\n${upstream}`,
    );
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (!(error instanceof InstallError)) throw error;
    console.error(`[install-desktop] ${error.message}`);
    process.exit(1);
  });
}
