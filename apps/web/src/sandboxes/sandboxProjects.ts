import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { findProjectByPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { readProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { readAgentctlBridge } from "./sandboxConnections";

export interface SandboxProjectInput {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  /** Whether T3 already made this Sandbox's project once, from the snapshot. */
  readonly projectCreated: boolean;
  /** Makes the project again even if it was made once and then removed. */
  readonly force: boolean;
}

export interface SandboxProjectResult {
  readonly created: boolean;
  readonly error: string | null;
}

export interface SandboxProjectDependencies {
  readonly workingDirectory: (name: string) => Promise<string>;
  readonly hasProjectAt: (environmentId: EnvironmentId, workspaceRoot: string) => boolean;
  /** Resolves with an error message, or null once the project exists. */
  readonly createProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly workspaceRoot: string;
  }) => Promise<string | null>;
  readonly markCreated: (name: string, environmentId: EnvironmentId) => Promise<void>;
}

/**
 * Gives a Sandbox its one project: its working directory, named after the
 * Agent, where agentctl Sessions start too. It is made once, so a project the
 * user removes stays removed unless `force` asks for it again.
 */
export async function ensureSandboxProject(
  dependencies: SandboxProjectDependencies,
  input: SandboxProjectInput,
): Promise<SandboxProjectResult> {
  if (input.projectCreated && !input.force) return { created: false, error: null };
  const workspaceRoot = await dependencies.workingDirectory(input.name);
  if (dependencies.hasProjectAt(input.environmentId, workspaceRoot)) {
    await dependencies.markCreated(input.name, input.environmentId);
    return { created: false, error: null };
  }
  const error = await dependencies.createProject({
    environmentId: input.environmentId,
    title: input.name,
    workspaceRoot,
  });
  if (error !== null) return { created: false, error };
  await dependencies.markCreated(input.name, input.environmentId);
  return { created: true, error: null };
}

// One at a time per environment and kind: a reconnect and a click can
// overlap, and a click must not be answered by the automatic attempt.
const inFlight = new Map<string, Promise<SandboxProjectResult>>();

export function useSandboxProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  return useCallback(
    (input: SandboxProjectInput): Promise<SandboxProjectResult> => {
      const bridge = readAgentctlBridge();
      if (bridge === null) return Promise.resolve({ created: false, error: null });
      const key = `${input.environmentId}:${input.force}`;
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const run = ensureSandboxProject(
        {
          workingDirectory: (name) =>
            bridge.getWorkspace(name).then((workspace) => workspace.workingDirectory),
          hasProjectAt: (environmentId, workspaceRoot) =>
            findProjectByPath(
              readProjects().filter((project) => project.environmentId === environmentId),
              workspaceRoot,
            ) !== undefined,
          createProject: async ({ environmentId, title, workspaceRoot }) => {
            const result = await createProject({
              environmentId,
              input: {
                projectId: newProjectId(),
                title,
                workspaceRoot,
                createWorkspaceRootIfMissing: false,
                defaultModelSelection: null,
              },
            });
            if (result._tag !== "Failure") return null;
            const failure = squashAtomCommandFailure(result);
            return failure instanceof Error ? failure.message : "Could not add the project.";
          },
          markCreated: (name, environmentId) => bridge.markProjectCreated({ name, environmentId }),
        },
        input,
      ).finally(() => inFlight.delete(key));
      inFlight.set(key, run);
      return run;
    },
    [createProject],
  );
}
