// A project folder that is no repository itself, such as an agentctl Sandbox's working directory,
// covers the repositories upstream's project model tracks for it. Pull requests and issues read
// those, so they cover what the project's Git actions and worktrees do.
import type { OrchestrationProjectShell, RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

type FolderProject = Pick<OrchestrationProjectShell, "workspaceRoot" | "trackedFolders">;

const atFolder = (identity: RepositoryIdentity, path: string): RepositoryIdentity =>
  identity.rootPath === undefined ? { ...identity, rootPath: path } : identity;

/**
 * For work on the server: the folders the project tracks, which its project reads bring in step
 * with the disk, each with its identity, resolved now if it is not cached.
 */
export const folderRepositories = Effect.fn("ProjectFolderRepositories.resolve")(function* (
  project: FolderProject,
) {
  const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const identities = yield* Effect.forEach(
    project.trackedFolders ?? [],
    (folder) =>
      resolver
        .resolve(folder.path)
        .pipe(
          Effect.map((identity) => (identity === null ? [] : [atFolder(identity, folder.path)])),
        ),
    { concurrency: 4 },
  );
  return identities.flat();
});

/**
 * A project shell for clients: its repository identity and, for a folder that is no repository,
 * the identities of the folders it tracks, as far as they are resolved. Never waits on git.
 */
export const enrichProjectShell = Effect.fn("ProjectFolderRepositories.enrichShell")(function* (
  project: OrchestrationProjectShell,
) {
  const enrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const own = yield* enrichment.getAvailable(project.workspaceRoot);
  const { workspaceRepositories: _previous, ...rest } = project;
  const folders = own.repositoryIdentity === null ? (project.trackedFolders ?? []) : [];
  const checkouts = (yield* Effect.forEach(
    folders,
    (folder) =>
      enrichment
        .getAvailable(folder.path)
        .pipe(
          Effect.map(({ repositoryIdentity }) =>
            repositoryIdentity === null ? [] : [atFolder(repositoryIdentity, folder.path)],
          ),
        ),
    { concurrency: 16 },
  )).flat();
  return {
    project: {
      ...rest,
      repositoryIdentity: own.repositoryIdentity,
      ...(checkouts.length > 0 ? { workspaceRepositories: checkouts } : {}),
    },
    repositoryIdentityResolved: own.repositoryIdentityResolved,
  };
});

/** Whether an enrichment of `path` changes the shell of `project`. */
export const projectCoversPath = (project: FolderProject, path: string) =>
  project.workspaceRoot === path ||
  (project.trackedFolders ?? []).some((folder) => folder.path === path);
