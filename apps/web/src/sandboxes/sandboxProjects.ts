import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { findProjectByPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { readProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { readAgentctlBridge } from "./sandboxConnections";

export interface SandboxProjectResult {
  readonly created: boolean;
  readonly error: string | null;
}

// One at a time per environment: a reconnect and a click can overlap.
const inFlight = new Map<EnvironmentId, Promise<SandboxProjectResult>>();

/**
 * Gives a Sandbox its one project: its working directory, named after the
 * Agent, where agentctl Sessions start too. It is made once, so a project the
 * user removes stays removed unless `force` asks for it again.
 */
export function useSandboxProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  return useCallback(
    (input: {
      readonly name: string;
      readonly environmentId: EnvironmentId;
      readonly force: boolean;
    }): Promise<SandboxProjectResult> => {
      const running = inFlight.get(input.environmentId);
      if (running !== undefined) return running;
      const run = (async (): Promise<SandboxProjectResult> => {
        const bridge = readAgentctlBridge();
        if (bridge === null) return { created: false, error: null };
        const workspace = await bridge.getWorkspace(input.name);
        if (workspace.projectCreated && !input.force) return { created: false, error: null };
        const markCreated = () =>
          bridge.markProjectCreated({ name: input.name, environmentId: input.environmentId });
        const projects = readProjects().filter(
          (project) => project.environmentId === input.environmentId,
        );
        if (findProjectByPath(projects, workspace.workingDirectory)) {
          await markCreated();
          return { created: false, error: null };
        }
        const result = await createProject({
          environmentId: input.environmentId,
          input: {
            projectId: newProjectId(),
            title: input.name,
            workspaceRoot: workspace.workingDirectory,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          return {
            created: false,
            error: failure instanceof Error ? failure.message : "Could not add the project.",
          };
        }
        await markCreated();
        return { created: true, error: null };
      })().finally(() => inFlight.delete(input.environmentId));
      inFlight.set(input.environmentId, run);
      return run;
    },
    [createProject],
  );
}
