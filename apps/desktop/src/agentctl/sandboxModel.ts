import {
  AgentctlSandboxSettings,
  DesktopSshEnvironmentTargetSchema,
  EnvironmentId,
  type AgentctlSandbox,
  type AgentctlSandboxAction,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  deriveAgentState,
  hasSshAccess,
  manifestVariant,
  sshAliasFor,
  type AgentResource,
} from "./agentState.ts";

/**
 * What T3 remembers about a Sandbox it reached: the environment its server
 * reported, so a stopped Sandbox still shows up as that environment, and the
 * repositories it already made projects for, so removing one sticks.
 */
export const SandboxRecord = Schema.Struct({
  sandboxId: Schema.NullOr(Schema.String),
  environmentId: EnvironmentId,
  sshTarget: Schema.NullOr(DesktopSshEnvironmentTargetSchema),
  seededRepositories: Schema.Array(Schema.String),
});
export type SandboxRecord = typeof SandboxRecord.Type;

export const SandboxStoreDocument = Schema.Struct({
  settings: Schema.optionalKey(AgentctlSandboxSettings),
  sandboxes: Schema.optionalKey(Schema.Record(Schema.String, SandboxRecord)),
});
export type SandboxStoreDocument = typeof SandboxStoreDocument.Type;

export const DEFAULT_SANDBOX_SETTINGS: AgentctlSandboxSettings = {
  manifestRoots: [],
  envFile: null,
};

/** In-memory state for one Sandbox; none of it survives a restart. */
export interface SandboxRuntime {
  readonly action: AgentctlSandboxAction | null;
  readonly actionError: string | null;
  readonly connectError: string | null;
}

export const IDLE_RUNTIME: SandboxRuntime = { action: null, actionError: null, connectError: null };

/**
 * Drops records for Sandboxes that are gone or were recreated under the same
 * name. A recreated Sandbox has a fresh disk and therefore a new environment.
 */
export function reconcileRecords(
  records: Readonly<Record<string, SandboxRecord>>,
  agents: ReadonlyArray<AgentResource>,
): Record<string, SandboxRecord> {
  const next: Record<string, SandboxRecord> = {};
  for (const [name, record] of Object.entries(records)) {
    const agent = agents.find((candidate) => candidate.metadata.name === name);
    if (agent === undefined || agent.metadata.deletionTimestamp !== undefined) continue;
    const sandboxId = agent.status?.sandbox?.id ?? null;
    if (sandboxId !== null && record.sandboxId !== null && sandboxId !== record.sandboxId) continue;
    next[name] = record;
  }
  return next;
}

export function buildSandbox(
  agent: AgentResource,
  record: SandboxRecord | undefined,
  runtime: SandboxRuntime,
): AgentctlSandbox {
  const state = deriveAgentState(agent);
  const manifestPath = agent.status?.provenance?.manifestPath ?? null;
  return {
    name: agent.metadata.name,
    phase: state.phase,
    detail: state.detail,
    sshAccess: hasSshAccess(agent),
    sshAlias: sshAliasFor(agent.metadata.name),
    sshTarget: record?.sshTarget ?? null,
    environmentId: record?.environmentId ?? null,
    connectError: state.phase === "ready" ? runtime.connectError : null,
    action: runtime.action,
    actionError: runtime.actionError,
    manifestPath,
    variant: manifestPath === null ? null : manifestVariant(manifestPath),
  };
}

/** Whether a lifecycle request T3 started has run its course. */
export function isActionSettled(action: AgentctlSandboxAction, agent: AgentResource | undefined) {
  if (action === "deleting") return agent === undefined;
  if (agent === undefined) return action !== "creating";
  const phase = deriveAgentState(agent).phase;
  switch (action) {
    case "creating":
    case "starting":
      return phase === "ready" || phase === "failed" || phase === "stopped";
    case "stopping":
      return phase === "stopped" || phase === "failed";
  }
}

// agentctl's own rule for `metadata.name`, so T3 rejects a bad name before applying.
const SANDBOX_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function sandboxNameError(
  name: string,
  existing: ReadonlyArray<AgentResource>,
): string | null {
  if (!SANDBOX_NAME.test(name)) {
    return "Use lowercase letters, digits and dashes, starting and ending with a letter or digit.";
  }
  // Applying an existing name updates that Sandbox's manifest instead of creating one.
  if (existing.some((agent) => agent.metadata.name === name)) {
    return `A Sandbox named ${name} already exists.`;
  }
  return null;
}

/** Suggests the manifest's own name, numbered when a Sandbox already has it. */
export function suggestSandboxName(
  agentName: string | null,
  existing: ReadonlyArray<AgentResource>,
): string {
  const base = agentName ?? "sandbox";
  const taken = new Set(existing.map((agent) => agent.metadata.name));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Lists the Git repositories directly under the working directory. A
 * repository without a commit yet is skipped: it is usually a clone still in
 * progress, and its directory may still be renamed.
 */
export const REPOSITORY_SCAN_SCRIPT = `for dir in "$1"/*/; do
  dir="\${dir%/}"
  [ -e "$dir/.git" ] || continue
  git -C "$dir" rev-parse --verify --quiet HEAD >/dev/null 2>&1 || continue
  printf '%s\\n' "$dir"
done
exit 0`;

export function parseRepositoryList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
}
