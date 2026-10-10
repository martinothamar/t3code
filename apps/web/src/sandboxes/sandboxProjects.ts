import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { findProjectByPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { readProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

export interface SandboxProjectInput {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly workingDirectory: string;
}

export interface SandboxProjectDependencies {
  readonly hasProjectAt: (environmentId: EnvironmentId, workspaceRoot: string) => boolean;
  /** Resolves with an error message, or null once the project exists. */
  readonly createProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly workspaceRoot: string;
  }) => Promise<string | null>;
}

/**
 * Gives a Sandbox its one project: its working directory, named after the
 * Agent, where agentctl Sessions start too. A call while one for the same
 * environment runs joins it, so a quick reconnect never makes a second.
 * Resolves with an error message, or null once the project exists.
 */
export function ensureSandboxProject(
  inFlight: Map<EnvironmentId, Promise<string | null>>,
  dependencies: SandboxProjectDependencies,
  input: SandboxProjectInput,
): Promise<string | null> {
  const running = inFlight.get(input.environmentId);
  if (running !== undefined) return running;
  if (dependencies.hasProjectAt(input.environmentId, input.workingDirectory)) {
    return Promise.resolve(null);
  }
  const attempt = dependencies
    .createProject({
      environmentId: input.environmentId,
      title: input.name,
      workspaceRoot: input.workingDirectory,
    })
    .finally(() => inFlight.delete(input.environmentId));
  inFlight.set(input.environmentId, attempt);
  return attempt;
}

const inFlight = new Map<EnvironmentId, Promise<string | null>>();

export function useEnsureSandboxProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  return useCallback(
    (input: SandboxProjectInput) =>
      ensureSandboxProject(
        inFlight,
        {
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
        },
        input,
      ),
    [createProject],
  );
}
