# T3 Code for agentctl Sandboxes

A fork of [T3 Code](https://github.com/pingdotgg/t3code) that runs agents in
[agentctl](https://github.com/digdir/digdir-agents) Sandboxes. It follows upstream's `main`; for
what T3 Code is and how to use it, see [upstream's README](https://github.com/pingdotgg/t3code#readme).

## Getting started

You need Git and [Node 24](https://nodejs.org). Clone the repository:

```sh
git clone https://github.com/martinothamar/t3code.git
cd t3code
```

Then install the desktop app, either the latest release:

```sh
node scripts/fork/install-desktop.ts
```

or a build of the checked-out commit, which also needs [`vp`](https://viteplus.dev/guide/), Rust
from [rustup](https://rustup.rs) and your platform's
[build tools](./docs/operations/development.md#linux-appimage-prerequisites):

```sh
node scripts/fork/install-desktop.ts --from-source
```

With Make installed, `make install` and `make install-source` run the same commands; `make` lists
the shortcuts. [Installing](./docs/operations/fork-desktop-build.md) has the details.

To connect to Sandboxes, run `agentctl ssh-config install` once, and give your Agents
`access: [{type: ssh}]` in their manifests. They then show up in the app; see
[agentctl Sandboxes](./docs/user/agentctl-sandboxes.md).

## Updating

We force-push `main` when updating the fork, so update your checkout with a fetch and hard reset
instead of `git pull`. Save local commits on another branch and stash uncommitted changes first:
the reset discards tracked changes and moves your local `main` to match `origin/main`.

```sh
git switch main
git fetch origin
git reset --hard origin/main
```

Or, while on `main`, run `make pull`. This updates the checkout; then run `make install` for the
latest desktop release or `make install-source` to build and install the updated checkout. Without
Make, run the corresponding install script above again.

## Developing the fork

[`agents/dev`](./agents/dev) is an agentctl Agent for working on this fork. Start at
[AGENTS.md](./AGENTS.md). Pull requests and issues go to this repository, not upstream.
