import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import { DesktopSshEnvironmentTargetSchema } from "./ipc.ts";

// agentctl Agent Sandboxes, discovered and managed by the desktop app. These
// types only cross the desktop IPC bridge, never the server wire: each Sandbox
// runs its own unmodified T3 server, reached over SSH like any SSH host.

/** Lifecycle of an Agent as agentctl reports it, derived like `agentctl tui` does. */
export const AgentctlSandboxPhase = Schema.Literals([
  "pending",
  "provisioning",
  "ready",
  "starting",
  "stopping",
  "stopped",
  "retrying",
  "unresponsive",
  "failed",
  "terminating",
]);
export type AgentctlSandboxPhase = typeof AgentctlSandboxPhase.Type;

/** A lifecycle request T3 started and is still waiting on. */
export const AgentctlSandboxAction = Schema.Literals([
  "creating",
  "starting",
  "stopping",
  "deleting",
]);
export type AgentctlSandboxAction = typeof AgentctlSandboxAction.Type;

export const AgentctlSandbox = Schema.Struct({
  name: Schema.String,
  phase: AgentctlSandboxPhase,
  /** Provisioning progress or the failure message, when there is one. */
  detail: Schema.NullOr(Schema.String),
  /** False when the manifest has no `ssh` access, so T3 cannot reach it. */
  sshAccess: Schema.Boolean,
  sshAlias: Schema.String,
  /** The SSH target as T3 resolved it when it first reached the Sandbox. */
  sshTarget: Schema.NullOr(DesktopSshEnvironmentTargetSchema),
  /** Known once T3 has reached the Sandbox's server; null before that. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Why T3 could not reach a Ready Sandbox, such as a missing SSH config include. */
  connectError: Schema.NullOr(Schema.String),
  action: Schema.NullOr(AgentctlSandboxAction),
  /** The last lifecycle request that failed, until the next one starts. */
  actionError: Schema.NullOr(Schema.String),
  manifestPath: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
});
export type AgentctlSandbox = typeof AgentctlSandbox.Type;

export const AgentctlSandboxesSnapshot = Schema.Struct({
  /** "unavailable" when agentctl is not installed or cannot reach its daemon. */
  status: Schema.Literals(["loading", "available", "unavailable"]),
  error: Schema.NullOr(Schema.String),
  sandboxes: Schema.Array(AgentctlSandbox),
});
export type AgentctlSandboxesSnapshot = typeof AgentctlSandboxesSnapshot.Type;

/** An `agent.yaml`, or a sibling `agent.<variant>.yaml`, found under a manifest root. */
export const AgentctlSandboxManifest = Schema.Struct({
  path: Schema.String,
  directory: Schema.String,
  variant: Schema.NullOr(Schema.String),
  /** `metadata.name`, the default name for a Sandbox applied from it. */
  agentName: Schema.NullOr(Schema.String),
});
export type AgentctlSandboxManifest = typeof AgentctlSandboxManifest.Type;

export const AgentctlSandboxSettings = Schema.Struct({
  /** Directories searched for manifests when creating a Sandbox. */
  manifestRoots: Schema.Array(Schema.String),
  /** Passed as `--env-file`; null uses agentctl's default `.env` beside the manifest. */
  envFile: Schema.NullOr(Schema.String),
});
export type AgentctlSandboxSettings = typeof AgentctlSandboxSettings.Type;

export const AgentctlCreateSandboxInput = Schema.Struct({
  manifestPath: Schema.String,
  name: Schema.String,
  envFile: Schema.NullOr(Schema.String),
});
export type AgentctlCreateSandboxInput = typeof AgentctlCreateSandboxInput.Type;

export const AgentctlSandboxRepoScanInput = Schema.Struct({
  name: Schema.String,
  /** False skips repositories T3 already created a project for once. */
  includeSeeded: Schema.Boolean,
});
export type AgentctlSandboxRepoScanInput = typeof AgentctlSandboxRepoScanInput.Type;

export const AgentctlSandboxRepoScan = Schema.Struct({
  workingDirectory: Schema.String,
  repositories: Schema.Array(Schema.String),
});
export type AgentctlSandboxRepoScan = typeof AgentctlSandboxRepoScan.Type;

export const AgentctlMarkReposSeededInput = Schema.Struct({
  name: Schema.String,
  environmentId: EnvironmentId,
  repositories: Schema.Array(Schema.String),
});
export type AgentctlMarkReposSeededInput = typeof AgentctlMarkReposSeededInput.Type;

/** Lifecycle requests resolve with agentctl's error message instead of rejecting. */
export const AgentctlActionResult = Schema.Struct({
  error: Schema.NullOr(Schema.String),
});
export type AgentctlActionResult = typeof AgentctlActionResult.Type;

export interface DesktopAgentctlBridge {
  /** The latest discovery result; cheap and synchronous, so callers poll it. */
  getSnapshot: () => AgentctlSandboxesSnapshot;
  refresh: () => Promise<AgentctlSandboxesSnapshot>;
  start: (name: string) => Promise<AgentctlActionResult>;
  stop: (name: string) => Promise<AgentctlActionResult>;
  remove: (name: string) => Promise<AgentctlActionResult>;
  create: (input: AgentctlCreateSandboxInput) => Promise<AgentctlActionResult>;
  listManifests: () => Promise<readonly AgentctlSandboxManifest[]>;
  getSettings: () => Promise<AgentctlSandboxSettings>;
  setSettings: (settings: AgentctlSandboxSettings) => Promise<AgentctlSandboxSettings>;
  scanRepositories: (input: AgentctlSandboxRepoScanInput) => Promise<AgentctlSandboxRepoScan>;
  markRepositoriesSeeded: (input: AgentctlMarkReposSeededInput) => Promise<void>;
}
