# Building the fork's desktop app

Build and install the fork's desktop app for the current user with:

```sh
node scripts/fork/install-desktop.ts
```

It runs on Linux, macOS and Windows from a clean checkout of the ref you want, and needs the
upstream tags (`git fetch upstream --tags`). The build names any tools it is missing, such as Rust
or ImageMagick. Leave the checkout alone while it runs: afterwards it restores every tracked file
that changed, because the build rewrites some. It installs:

- **Linux** (x64 only): the AppImage as `~/.local/bin/t3code`, with the launcher
  `~/.local/share/applications/t3code.desktop` and the icon `~/.local/share/icons/t3code.png`.
- **macOS:** the app into `~/Applications`.
- **Windows:** the app through its installer, run silently. The installer shares upstream's app ID
  and would replace an upstream install, so the script refuses to run while one is installed.

Running it again replaces the previous build in place. It reports an upstream install it finds,
such as the AUR package or the Homebrew cask, but never removes one. Remove an upstream install if
you want only the fork's build: it updates itself to upstream builds. Do not use
`brew uninstall --zap`, which deletes `~/.t3/userdata`.

## The version

The desktop app installs the T3 server on SSH hosts, agentctl Sandboxes included, from
`pingdotgg/t3code` releases, choosing the release that matches its own version. The fork changes
only desktop and client code, so its Sandboxes run upstream's server unmodified, and that works as
long as the version names an upstream release whose server matches the fork's.

So the script stamps the build with the newest upstream nightly reachable from the checked-out ref:

```sh
git describe --tags --abbrev=0 --match 'v*-nightly.*' | sed 's/^v//'
```

Syncs merge `upstream/main`, so that is the newest nightly the last sync brought in. Any other
version, such as `0.0.45-fork.<sha>`, builds fine and then fails when a host tries to install its
server. Never merge a newer upstream nightly to change the version; the version follows the ref.
The script checks that upstream publishes the server archives for the version before it builds.

Sandboxes then run that nightly's server, which can trail the fork's client by the upstream commits
merged since it. The build has no update feed, so it never replaces itself with an upstream build.

For `vp run dev:desktop`, or to override a build, set the server release directly:

- `T3CODE_REMOTE_SERVER_VERSION`: the release SSH hosts install, such as
  `0.0.46-nightly.20261010.2922`.
- `T3CODE_REMOTE_SERVER_RELEASE_BASE_URL`: where release archives are downloaded from, for when the
  fork publishes its own server releases.
