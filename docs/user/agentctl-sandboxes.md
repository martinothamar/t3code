# agentctl Sandboxes

The desktop app finds the [agentctl](https://github.com/digdir/digdir-agents) Agents on your
computer and connects to each running one as its own environment, the same way it connects to a
[desktop-managed SSH host](./remote-access.md#desktop-managed-ssh). Each Git repository directly in
the Sandbox's working directory becomes a project, so you can start threads there right away.
Agents in a Sandbox use the provider credentials agentctl gives it.

## Before you start

- Run `agentctl ssh-config install` once, so SSH can reach `agentctl-<name>` hosts.
- Give the Agent SSH access in its manifest with `access: [{type: ssh}]`. agentctl needs an image
  with OpenSSH and systemd for that.

## Use a Sandbox

- **Start a thread in one.** In the new thread's location picker, choose the Sandbox. A stopped
  Sandbox is started when you pick it, and the draft moves to it once it holds the project.
- **Create one.** Choose **New Sandbox…** in the location picker or the command palette, pick a
  manifest and an env file, and name it. Manifests are found under the folders set in
  **Settings → Connections → agentctl Sandboxes**.
- **Start, stop or delete.** From **Settings → Connections → agentctl Sandboxes** or **Manage
  Sandboxes…** in the command palette.

## Good to know

- Stopping keeps the Sandbox's disk. Its threads stay listed and reconnect when it starts again.
  Deleting removes the disk, and with it the Sandbox's projects and threads in T3 Code.
- Repositories cloned after the Sandbox starts are picked up for a few minutes; use **Find
  projects** in Settings for later ones. A project you remove is not added back on its own.
- Threads started from T3 Code run outside agentctl Sessions. They do not appear in `agentctl turns`
  or the agentctl TUI, and the manifest's default model does not apply: choose the model in T3 Code.
- Sandboxes are available in the desktop app only.
