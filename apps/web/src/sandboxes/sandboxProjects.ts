import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useStableCallback } from "../hooks/useStableCallback";

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
 * Agent, where agentctl Sessions start too. The server allows one project per
 * folder, so a create racing another window's fails, and finds the project
 * there afterwards. Resolves with an error message, or null once it exists.
 */
export async function ensureSandboxProject(
  dependencies: SandboxProjectDependencies,
  input: SandboxProjectInput,
): Promise<string | null> {
  const exists = () => dependencies.hasProjectAt(input.environmentId, input.workingDirectory);
  if (exists()) return null;
  const error = await dependencies.createProject({
    environmentId: input.environmentId,
    title: input.name,
    workspaceRoot: input.workingDirectory,
  });
  return error === null || exists() ? null : error;
}

export function useEnsureSandboxProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  // Stable, since the connection coordinator runs it from an effect.
  return useStableCallback((input: SandboxProjectInput) =>
    ensureSandboxProject(
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
  );
}
