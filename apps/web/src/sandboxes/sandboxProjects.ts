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

/**
 * One attempt per environment at a time. An automatic attempt joins one that
 * is already running. A forced one, from a click, waits for it and then runs
 * unless that attempt made the project, so the click never races it.
 */
export function queueSandboxProject(
  inFlight: Map<EnvironmentId, Promise<SandboxProjectResult>>,
  environmentId: EnvironmentId,
  force: boolean,
  start: () => Promise<SandboxProjectResult>,
): Promise<SandboxProjectResult> {
  const running = inFlight.get(environmentId);
  if (running !== undefined && !force) return running;
  const queued =
    running === undefined
      ? start()
      : running.then((result) => (result.created ? result : start()), start);
  const run = queued.finally(() => {
    if (inFlight.get(environmentId) === run) inFlight.delete(environmentId);
  });
  inFlight.set(environmentId, run);
  return run;
}

const inFlight = new Map<EnvironmentId, Promise<SandboxProjectResult>>();

export function useSandboxProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  return useCallback(
    (input: SandboxProjectInput): Promise<SandboxProjectResult> => {
      const bridge = readAgentctlBridge();
      if (bridge === null) return Promise.resolve({ created: false, error: null });
      return queueSandboxProject(inFlight, input.environmentId, input.force, () =>
        ensureSandboxProject(
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
            markCreated: (name, environmentId) =>
              bridge.markProjectCreated({ name, environmentId }),
          },
          input,
        ),
      );
    },
    [createProject],
  );
}
