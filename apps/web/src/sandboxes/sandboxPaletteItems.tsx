import type { AgentctlSandbox } from "@t3tools/contracts";
import { BoxIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { openNewSandboxDialog } from "./NewSandboxDialog";
import {
  canDeleteSandbox,
  canStartSandbox,
  canStopSandbox,
  deleteSandbox,
  sandboxStatus,
  startSandbox,
  stopSandbox,
} from "./sandboxActions";
import { useOffersSandboxes } from "./sandboxNotices";
import { readSandboxSnapshot, useSandboxSelector } from "./useSandboxes";

function sandboxActions(sandbox: AgentctlSandbox): CommandPaletteActionItem[] {
  const terms = [sandbox.name, "sandbox", "agentctl"];
  const description = sandboxStatus(sandbox).label;
  return [
    ...(canStartSandbox(sandbox)
      ? [
          {
            kind: "action" as const,
            value: `agentctl-sandbox:start:${sandbox.name}`,
            title: `Start ${sandbox.name}`,
            description,
            searchTerms: ["start", "resume", "boot", ...terms],
            icon: <PlayIcon className={ITEM_ICON_CLASS} />,
            run: async () => void (await startSandbox(sandbox)),
          },
        ]
      : []),
    ...(canStopSandbox(sandbox)
      ? [
          {
            kind: "action" as const,
            value: `agentctl-sandbox:stop:${sandbox.name}`,
            title: `Stop ${sandbox.name}`,
            description,
            searchTerms: ["stop", "pause", "shut down", ...terms],
            icon: <SquareIcon className={ITEM_ICON_CLASS} />,
            run: async () => void (await stopSandbox(sandbox)),
          },
        ]
      : []),
    ...(canDeleteSandbox(sandbox)
      ? [
          {
            kind: "action" as const,
            value: `agentctl-sandbox:delete:${sandbox.name}`,
            title: `Delete ${sandbox.name}`,
            description,
            searchTerms: ["delete", "remove", "destroy", ...terms],
            icon: <Trash2Icon className={ITEM_ICON_CLASS} />,
            run: async () => void (await deleteSandbox(sandbox)),
          },
        ]
      : []),
  ];
}

/** What the items show, so provisioning progress alone does not re-render the palette. */
function paletteKey(sandbox: AgentctlSandbox): string {
  return [
    sandbox.name,
    sandboxStatus(sandbox).label,
    canStartSandbox(sandbox),
    canStopSandbox(sandbox),
    canDeleteSandbox(sandbox),
  ].join(":");
}

export function useSandboxPaletteItems() {
  const offered = useOffersSandboxes();
  const key = useSandboxSelector((snapshot) => snapshot.sandboxes.map(paletteKey).join("|"));
  return useMemo(
    () => sandboxPaletteItems(offered, key === "" ? [] : readSandboxSnapshot().sandboxes),
    [offered, key],
  );
}

/** "New Sandbox…" and a submenu with each Sandbox's start, stop and delete. */
function sandboxPaletteItems(
  offered: boolean,
  sandboxes: ReadonlyArray<AgentctlSandbox>,
): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  if (!offered) return [];
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:new-agentctl-sandbox",
      title: "New Sandbox…",
      searchTerms: ["new sandbox", "create sandbox", "agentctl", "apply", "manifest", "vm"],
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openNewSandboxDialog(),
    },
  ];
  const groups = sandboxes
    .map((sandbox) => ({
      value: `agentctl-sandbox:${sandbox.name}`,
      label: sandbox.name,
      items: sandboxActions(sandbox),
    }))
    .filter((group) => group.items.length > 0);
  if (groups.length > 0) {
    items.push({
      kind: "submenu",
      value: "action:manage-agentctl-sandboxes",
      title: "Manage Sandboxes…",
      // Names too, so "stop worker" finds the submenu from the top level.
      searchTerms: [
        "sandbox",
        "agentctl",
        "start",
        "stop",
        "delete",
        "vm",
        ...sandboxes.map((sandbox) => sandbox.name),
      ],
      icon: <BoxIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <BoxIcon className={ADDON_ICON_CLASS} />,
      groups,
    });
  }
  return items;
}
