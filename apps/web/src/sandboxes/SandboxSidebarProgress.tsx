import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AgentctlSandbox } from "@t3tools/contracts";
import { BoxIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useProjects, useThreadShells } from "../state/entities";
import { forgetCreatedSandbox, useCreatedSandboxes } from "./createdSandboxes";
import { deleteSandbox, sandboxStatus, sandboxStatusDetail } from "./sandboxActions";
import { useSandboxes } from "./useSandboxes";

const SETTING_UP = new Set<AgentctlSandbox["phase"]>([
  "pending",
  "provisioning",
  "starting",
  "retrying",
  "failed",
  "unresponsive",
]);

/** A Sandbox still being set up, or one this window made that has no thread yet. */
function isShown(sandbox: AgentctlSandbox, created: ReadonlySet<string>): boolean {
  if (sandbox.phase === "terminating") return false;
  if (sandbox.action === "creating" || created.has(sandbox.name)) return true;
  return sandbox.environmentId === null && SETTING_UP.has(sandbox.phase);
}

/**
 * Sandboxes on their way in, at the top of the sidebar: provisioning
 * progress while agentctl sets one up, then a way into its first thread.
 */
export function SandboxSidebarProgress() {
  const sandboxes = useSandboxes();
  const created = useCreatedSandboxes();
  const shown = sandboxes.filter((sandbox) => isShown(sandbox, created));
  // The thread and project subscriptions only run while something is shown.
  return shown.length === 0 ? null : <SandboxProgressRows sandboxes={shown} />;
}

function SandboxProgressRows({
  sandboxes,
}: {
  readonly sandboxes: ReadonlyArray<AgentctlSandbox>;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const openThread = useNewThreadHandler();
  const created = useCreatedSandboxes();
  const environmentsWithThreads = new Set<string>(threads.map((thread) => thread.environmentId));
  // Its first thread is the hand-off: from then on the thread list shows it.
  const startedKey = sandboxes
    .filter(
      (sandbox) =>
        sandbox.environmentId !== null && environmentsWithThreads.has(sandbox.environmentId),
    )
    .map((sandbox) => sandbox.name)
    .join("\n");
  useEffect(() => {
    for (const name of startedKey.split("\n")) if (name) forgetCreatedSandbox(name);
  }, [startedKey]);

  return (
    <ul className="mb-1 flex list-none flex-col gap-0.5 px-1">
      {sandboxes.map((sandbox) => {
        if (sandbox.environmentId !== null && environmentsWithThreads.has(sandbox.environmentId)) {
          return null;
        }
        const project =
          sandbox.environmentId === null
            ? null
            : (projects.find((candidate) => candidate.environmentId === sandbox.environmentId) ??
              null);
        const ready = sandbox.phase === "ready" && sandbox.action === null && project !== null;
        const status = sandboxStatus(sandbox);
        const failed = sandbox.action === null && sandbox.phase === "failed";
        const detail = ready ? null : sandboxStatusDetail(sandbox);
        return (
          <li
            key={sandbox.name}
            className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground text-xs"
          >
            <BoxIcon
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{sandbox.name}</span>
                <span className="shrink-0 text-sidebar-muted-foreground">
                  {ready ? "Ready" : status.label}
                </span>
              </div>
              {detail ? (
                <div className="line-clamp-2 break-words text-sidebar-muted-foreground/70">
                  {detail}
                </div>
              ) : null}
              {ready && project !== null ? (
                <button
                  type="button"
                  className="mt-0.5 cursor-pointer text-sidebar-muted-foreground hover:text-sidebar-foreground"
                  onClick={() => {
                    forgetCreatedSandbox(sandbox.name);
                    void openThread(scopeProjectRef(project.environmentId, project.id));
                  }}
                >
                  New thread
                </button>
              ) : failed ? (
                <button
                  type="button"
                  className="mt-0.5 cursor-pointer text-sidebar-muted-foreground hover:text-sidebar-foreground"
                  onClick={() => void deleteSandbox(sandbox)}
                >
                  Delete
                </button>
              ) : null}
            </div>
            {created.has(sandbox.name) && (ready || failed) ? (
              <button
                type="button"
                aria-label={`Dismiss ${sandbox.name}`}
                className="shrink-0 cursor-pointer text-sidebar-muted-foreground/60 hover:text-sidebar-foreground"
                onClick={() => forgetCreatedSandbox(sandbox.name)}
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
