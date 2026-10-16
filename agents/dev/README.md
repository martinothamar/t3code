# T3 Code development Agent

An [agentctl](https://github.com/digdir/digdir-agents) Agent for developing this fork inside a
Sandbox: Ubuntu with Node 24, `vp`, Rust, Claude Code, Codex, `agentctl`/`agentd` for nested
Agents, and a desktop for the Electron client that agents drive with the `desktop` helper and the
`computer-use` skill. It clones the fork into `/home/agent/code/t3code` at boot. The `demo-video`
skill films that desktop into captioned demo videos with fframes.

| Variant  | Image                                   | Checkout                                                |
| -------- | --------------------------------------- | ------------------------------------------------------- |
| default  | Published `t3code-dev:latest`           | Fresh clone of `martinothamar/t3code`, `upstream` added |
| `nested` | Built from this checkout's `Dockerfile` | Fresh clone, reduced to fit inside the default Agent    |

The **Fork dev image** workflow builds Linux amd64 and arm64 images when `agents/dev/` changes.
Pull requests only build; changes on `main` also publish
`ghcr.io/martinothamar/t3code/t3code-dev:latest` and `sha-<first 10 commit characters>`, with
layers cached in GHCR. Run it manually on `main` to rebuild without a source change:

```sh
gh workflow run fork-dev-image.yml --ref main
```

After the first publish, set the GHCR package's visibility to **Public** so Agent hosts can pull
it without registry credentials. Use the `nested` variant to try local image changes:

```sh
agentctl apply -f agents/dev/agent.nested.yaml --wait
```

```sh
cp agents/dev/.env.sample agents/dev/.env   # fill in GITHUB_TOKEN and Git identity
agentctl apply -f agents/dev/agent.yaml --wait
agentctl attach session/s1 --agent t3code-dev   # creates the Session on first attach
```

`agentctl vnc t3code-dev --web --open` shows the desktop, and the SSH alias `agentctl-t3code-dev`
connects editors and T3 Code itself.
