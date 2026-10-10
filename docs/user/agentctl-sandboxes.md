# agentctl Sandboxes

The desktop app finds the [agentctl](https://github.com/digdir/digdir-agents) Agents on your
computer and connects to each running one as its own environment, the same way it connects to a
[desktop-managed SSH host](./remote-access.md#desktop-managed-ssh). Each Sandbox gets one project,
named after the Agent, at its working directory: the same place agentctl Sessions start, so agents
can work across every repository in it. Agents in a Sandbox use the provider credentials agentctl
gives it.

## Before you start

- Run `agentctl ssh-config install` once, so SSH can reach `agentctl-<name>` hosts.
- Give the Agent SSH access in its manifest with `access: [{type: ssh}]`. agentctl needs an image
  with OpenSSH and systemd for that.

## Use a Sandbox

- **Start a thread in one.** Pick the Sandbox's project for a new thread, as you would any project.
  If the Sandbox is stopped, the composer says so and offers **Start**.
- **Create one.** Choose **New Sandbox** in the sidebar, or **New Sandbox…** in the command palette
  or **Settings → Connections → agentctl Sandboxes**. The first time, choose a folder with your
  manifests; T3 Code finds every `agent.yaml` and `agent.<variant>.yaml` in it. Values come from the
  `.env` beside the manifest, as with `agentctl apply`. The name gets the next free number, like
  `worker-3`. The sidebar shows the Sandbox while agentctl sets it up, then offers **New thread**.
- **Start, stop or delete.** From **Settings → Connections → agentctl Sandboxes** or **Manage
  Sandboxes…** in the command palette.

## Good to know

- Stopping keeps the Sandbox's disk. Its threads stay listed and reconnect when it starts again.
  Deleting removes the disk, and with it the Sandbox's project and threads in T3 Code.
- The working directory is usually not a Git repository itself, so T3 Code's turn diffs, restore
  and worktree mode are not available there. Agents still use Git in each repository.
- A Sandbox's project is added once. If you remove it, **Add project** in Settings brings it back.
- Threads started from T3 Code run outside agentctl Sessions. They do not appear in `agentctl turns`
  or the agentctl TUI, and the manifest's default model does not apply: choose the model in T3 Code.
- Sandboxes are available in the desktop app only.
