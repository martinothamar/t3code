# T3 Code development Agent

An [agentctl](https://github.com/digdir/digdir-agents) Agent for developing this fork inside a
Sandbox. It builds on the [agentctl desktop base image](https://github.com/digdir/digdir-agents/tree/main/images/agentctl-base),
which brings Claude Code, Codex, Chromium and a desktop for the Electron client that agents drive
with the `desktop` helper and the `computer-use` skill, and adds Node 26, `vp`, Rust, Podman and
`agentctl`/`agentd` for nested Agents. It clones the fork into `/home/agent/code/t3code` at boot.
The `demo-video` skill films that desktop into captioned demo videos with fframes.

| Variant  | Checkout                                                |
| -------- | ------------------------------------------------------- |
| default  | Fresh clone of `martinothamar/t3code`, `upstream` added |
| `nested` | Fresh clone, reduced to fit inside the default Agent    |

```sh
cp agents/dev/.env.sample agents/dev/.env   # fill in GITHUB_TOKEN and Git identity
agentctl apply -f agents/dev/agent.yaml --wait
agentctl attach session/s1 --agent t3code-dev   # creates the Session on first attach
```

`agentctl vnc t3code-dev --web --open` shows the desktop, and the SSH alias `agentctl-t3code-dev`
connects editors and T3 Code itself.
