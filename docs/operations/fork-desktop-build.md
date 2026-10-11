# Releasing and installing the fork's desktop app

## Releases

Run the **Fork release** workflow (`.github/workflows/fork-release.yml`) from the Actions tab. It
publishes one GitHub release of this repository with:

- the desktop apps: the Linux x64 and arm64 AppImages, the macOS arm64 dmg, and the Windows x64
  installer, which embeds the linux-x64 server for its WSL backend;
- the T3 server archives SSH hosts install, agentctl Sandboxes included: linux-x64, linux-arm64 and
  darwin-arm64, the hosts the SSH installer supports;
- `SHA256SUMS` over all of them.

A run on `main` becomes the latest release. A run on another branch publishes a prerelease, which
nothing installs unless asked for by version, for trying a change before it merges.

The desktop app installs the server on an SSH host from this repository's releases, choosing the
release that matches its own version (`apps/desktop/src/ssh/remoteServerOverrides.ts`). So the
fork's server changes reach Sandboxes, and an app always gets the server built with it.

Nothing is signed. The apps carry no update feed, so they never replace themselves; installing a
newer release is running the install script again.

## The version

Releases use upstream's preview form, `<core>-preview.<YYYYMMDD>.<run>`, such as
`0.0.46-preview.20261011.3`, where `<core>` is `apps/desktop/package.json`'s version and `<run>`
the workflow's run number. The desktop build gives a preview version no update feed, which keeps
the CI build from pointing the app at this repository's releases, and the app shows the same
Nightly name as upstream's nightly builds. Each release notes the upstream nightly it is based on.

The client warns about a server older than itself by comparing core versions only for previews, so
it does not notice a Sandbox on an older fork release with the same core. Reinstalling the app and
reconnecting installs the matching server.

## Installing

```sh
node scripts/fork/install-desktop.ts
```

It needs only Node, in a checkout of this repository, on Linux (x64 or arm64), macOS (Apple
silicon) or Windows (x64). It downloads the latest release, or the one `--version <version>` names,
checks it against the release's `SHA256SUMS`, and installs:

- **Linux:** the AppImage as `~/.local/bin/t3code`, with the launcher
  `~/.local/share/applications/t3code.desktop` and the icon `~/.local/share/icons/t3code.png`.
- **macOS:** the app into `~/Applications`.
- **Windows:** the app through its installer, run silently. The installer shares upstream's app ID
  and would replace a per-user upstream install, so the script refuses to run while one is
  installed.

Running it again replaces the previous install in place. It reports an upstream install it finds,
such as the AUR package or the Homebrew cask, but never removes one. Remove an upstream install if
you want only the fork's: it updates itself to upstream builds. Do not use
`brew uninstall --zap`, which deletes `~/.t3/userdata`.

Install with the script rather than from the release page: a browser marks the download, so
Gatekeeper blocks the unsigned macOS app and SmartScreen warns about the Windows installer.

## Building from source

```sh
node scripts/fork/install-desktop.ts --from-source
```

Builds the checked-out commit instead of downloading, from a clean checkout. The build names any
tools it is missing, such as Rust or ImageMagick. It is stamped with the version of the release
published from that commit, so its SSH hosts get a matching server; without such a release the
script refuses, and you run the workflow on the commit first. Leave the checkout alone while it
runs: afterwards it restores every tracked file that changed, because the build rewrites some.

For `vp run dev:desktop`, or to try another server, set these before starting the app:

- `T3CODE_REMOTE_SERVER_VERSION`: the release SSH hosts install, such as
  `0.0.46-preview.20261011.3`.
- `T3CODE_REMOTE_SERVER_RELEASE_BASE_URL`: where release archives are downloaded from, such as
  `https://github.com/pingdotgg/t3code/releases/download` for upstream's.
