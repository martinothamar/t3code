// A project folder that is no repository itself, such as an agentctl Sandbox's working directory,
// covers the repositories upstream's project model tracks for it. Pull requests and issues read
// those, so they cover what the project's Git actions and worktrees do.
import type { OrchestrationProjectShell, RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

type FolderProject = Pick<OrchestrationProjectShell, "workspaceRoot" | "trackedFolders">;

const trimmed = (path: string) => path.replace(/[\\/]+$/u, "");

/**
 * The repository a tracked folder is, with its path. A plain folder inside a repository resolves
 * to that repository, which the project's Git actions do not cover, so it is none.
 */
const checkoutAt = (identity: RepositoryIdentity | null, path: string) => {
  if (identity === null) return [];
  const root = identity.rootPath === undefined ? undefined : trimmed(identity.rootPath);
  const folder = trimmed(path);
  if (
    root !== undefined &&
    root !== folder &&
    /^[\\/]/u.test(folder.slice(root.length)) &&
    folder.startsWith(root)
  ) {
    return [];
  }
  return [root === undefined ? { ...identity, rootPath: path } : identity];
};

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
        .pipe(Effect.map((identity) => checkoutAt(identity, folder.path))),
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
        .pipe(Effect.map(({ repositoryIdentity }) => checkoutAt(repositoryIdentity, folder.path))),
    { concurrency: 16 },
  )).flat();
  return {
    project: {
      ...rest,
      repositoryIdentity: own.repositoryIdentity,
      // Sent even when empty once the folder is known to be no repository: the client keeps a
      // missing list as not resolved yet, which would keep a checkout that was untracked.
      ...(checkouts.length > 0 ||
      (own.repositoryIdentityResolved && own.repositoryIdentity === null)
        ? { workspaceRepositories: checkouts }
        : {}),
    },
    repositoryIdentityResolved: own.repositoryIdentityResolved,
  };
});

/** Whether an enrichment of `path` changes the shell of `project`. */
const projectCoversPath = (project: FolderProject, path: string) =>
  project.workspaceRoot === path ||
  (project.trackedFolders ?? []).some((folder) => folder.path === path);

/**
 * The shells enrichment changes at `paths` refresh: each project rooted at one, and each folder
 * project tracking one, with the roots whose identity is now resolved.
 */
export const enrichmentRefresh = Effect.fn("ProjectFolderRepositories.refresh")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  paths: ReadonlyArray<string>,
) {
  const refreshed = yield* Effect.forEach(
    projects.filter((project) => paths.some((path) => projectCoversPath(project, path))),
    enrichProjectShell,
    { concurrency: 16 },
  );
  return {
    projects: refreshed.map(({ project }) => project),
    resolvedRoots: refreshed.flatMap(({ project, repositoryIdentityResolved }) =>
      repositoryIdentityResolved ? [project.workspaceRoot] : [],
    ),
  };
});
