# Building the fork's desktop app

The desktop app installs the T3 server on SSH hosts, agentctl Sandboxes included, from
`pingdotgg/t3code` releases, choosing the release that matches its own version. The fork changes
only desktop and client code, so its Sandboxes run upstream's server unmodified, and that works as
long as the version names an upstream release whose server matches the fork's.

Syncs merge `upstream/main`, so a build is stamped with the newest nightly that merge contains.
Find it with `git describe --tags --abbrev=0 --match 'v*-nightly.*'`, drop the leading `v`, and
build for the host's platform with `T3CODE_DESKTOP_VERSION` set to it:

- macOS: `vp run dist:desktop:dmg`
- Linux: `vp run dist:desktop:linux`
- Windows: `vp run dist:desktop:win`

For example, on macOS or Linux:

```sh
T3CODE_DESKTOP_VERSION="$(git describe --tags --abbrev=0 --match 'v*-nightly.*' | sed 's/^v//')" \
  vp run dist:desktop:linux
```

Sandboxes then run that nightly's server, which can trail the fork's client by the upstream commits
merged since it. A local build has no update feed unless `T3CODE_DESKTOP_UPDATE_REPOSITORY` is set,
so it never replaces itself with an upstream build.

For `vp run dev:desktop`, or to override a build, set the server release directly:

- `T3CODE_REMOTE_SERVER_VERSION`: the release SSH hosts install, such as
  `0.0.46-nightly.20261010.2922`.
- `T3CODE_REMOTE_SERVER_RELEASE_BASE_URL`: where release archives are downloaded from, for when the
  fork publishes its own server releases.
