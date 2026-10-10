# Building the fork's desktop app

The desktop app installs the T3 server on SSH hosts, agentctl Sandboxes included, from
`pingdotgg/t3code` releases, choosing the release that matches its own version. The fork changes
only desktop and client code, so its Sandboxes run upstream's server unmodified, and that works as
long as the version names an upstream release whose server matches the fork's.

Stamp a build with the nightly the fork last merged:

```sh
T3CODE_DESKTOP_VERSION="$(git describe --tags --abbrev=0 --match 'v*-nightly.*' | sed 's/^v//')" \
  vp run dist:desktop:linux
```

Sync merges should target a nightly tag rather than the tip of `upstream/main`, so the fork's
server code is exactly that release. A local build has no update feed unless
`T3CODE_DESKTOP_UPDATE_REPOSITORY` is set, so it never replaces itself with an upstream build.

For `vp run dev:desktop`, or to override a build, set the server release directly:

- `T3CODE_REMOTE_SERVER_VERSION`: the release SSH hosts install, such as
  `0.0.46-nightly.20261010.2922`.
- `T3CODE_REMOTE_SERVER_RELEASE_BASE_URL`: where release archives are downloaded from, for when the
  fork publishes its own server releases.
