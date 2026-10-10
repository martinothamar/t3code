import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { readProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { readAgentctlBridge } from "./sandboxConnections";

export interface SandboxProjectSeedResult {
  readonly created: number;
  readonly error: string | null;
}

// One scan per environment at a time: a reconnect and a manual rescan can overlap.
const inFlight = new Map<EnvironmentId, Promise<SandboxProjectSeedResult>>();

/**
 * Creates a project for each Git repository in a Sandbox's working directory.
 * A repository it created a project for once is skipped afterwards unless
 * `includeSeeded` is set, so removing such a project sticks until a manual
 * rescan.
 */
export function useSandboxProjectSeeding() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  return useCallback(
    (input: {
      readonly name: string;
      readonly environmentId: EnvironmentId;
      readonly includeSeeded: boolean;
    }): Promise<SandboxProjectSeedResult> => {
      const running = inFlight.get(input.environmentId);
      if (running !== undefined) return running;
      const run = (async (): Promise<SandboxProjectSeedResult> => {
        const bridge = readAgentctlBridge();
        if (bridge === null) return { created: 0, error: null };
        const scan = await bridge.scanRepositories({
          name: input.name,
          includeSeeded: input.includeSeeded,
        });
        const seeded: string[] = [];
        let created = 0;
        let error: string | null = null;
        for (const repository of scan.repositories) {
          const projects = readProjects().filter(
            (project) => project.environmentId === input.environmentId,
          );
          if (findProjectByPath(projects, repository)) {
            seeded.push(repository);
            continue;
          }
          const result = await createProject({
            environmentId: input.environmentId,
            input: {
              projectId: newProjectId(),
              title: inferProjectTitleFromPath(repository),
              workspaceRoot: repository,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            error ??= failure instanceof Error ? failure.message : "Could not add a project.";
            continue;
          }
          seeded.push(repository);
          created += 1;
        }
        if (seeded.length > 0) {
          await bridge.markRepositoriesSeeded({
            name: input.name,
            environmentId: input.environmentId,
            repositories: seeded,
          });
        }
        return { created, error };
      })().finally(() => inFlight.delete(input.environmentId));
      inFlight.set(input.environmentId, run);
      return run;
    },
    [createProject],
  );
}
