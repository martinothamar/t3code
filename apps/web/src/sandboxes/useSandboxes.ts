import { useAtomValue } from "@effect/atom-react";
import type { HostedSandbox, SandboxHost } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { sandboxEnvironment } from "../state/sandboxes";

const offersSandboxesAtom = Atom.make((get) =>
  get(sandboxEnvironment.hostsValueAtom).some((host) => host.snapshot.status === "available"),
).pipe(Atom.withLabel("sandboxes:offered"));

/** Where New Sandbox goes when nothing names a host: the first that can reach agentctl. */
const defaultHostAtom = Atom.make(
  (get) =>
    get(sandboxEnvironment.hostsValueAtom).find((host) => host.snapshot.status === "available")
      ?.hostEnvironmentId ?? null,
).pipe(Atom.withLabel("sandboxes:default-host"));

export function useSandboxHosts(): ReadonlyArray<SandboxHost> {
  return useAtomValue(sandboxEnvironment.hostsValueAtom);
}

export function useSandboxHost(hostEnvironmentId: EnvironmentId | null): SandboxHost | null {
  return useSandboxHosts().find((host) => host.hostEnvironmentId === hostEnvironmentId) ?? null;
}

export function useSandboxes(): ReadonlyArray<HostedSandbox> {
  return useAtomValue(sandboxEnvironment.sandboxesAtom);
}

/** Every host's Sandboxes now, for code outside React. */
export function readSandboxes(): ReadonlyArray<HostedSandbox> {
  return appAtomRegistry.get(sandboxEnvironment.sandboxesAtom);
}

export function readDefaultSandboxHost(): EnvironmentId | null {
  return appAtomRegistry.get(defaultHostAtom);
}

/** Whether a connected host can reach agentctl, so Sandbox actions are worth offering. */
export function useOffersSandboxes(): boolean {
  return useAtomValue(offersSandboxesAtom);
}
