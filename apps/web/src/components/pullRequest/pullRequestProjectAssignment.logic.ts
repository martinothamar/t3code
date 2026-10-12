import type { EnvironmentId, EnvironmentMachineKind, ProjectId } from "@t3tools/contracts";

/** The little of a project this needs: who holds it, and which repository it is a copy of. */
export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
  /** For a folder that is no repository, the checkouts it holds. */
  readonly workspaceRepositories?:
    | ReadonlyArray<{ readonly canonicalKey?: string | undefined; readonly rootPath?: string }>
    | undefined;
}

/**
 * The remote's normalized URL is what says "same repository" across machines — it comes from the
 * remote, not from a local path. Empty where the project has no identity to compare with.
 *
 * `normalizeGitRemoteUrl` already lower-cases the whole remote, so the key arrives cased one way
 * whatever the remote said; the fold here only guards a key assembled some other way.
 */
function repositoryKey(project: AssignableProject): string | undefined {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase();
}

/** The repositories a project lists: its own, or a folder's checkouts. */
function repositoryKeysOf(project: AssignableProject): ReadonlyArray<string> {
  const own = repositoryKey(project);
  if (own) return [own];
  return [
    ...new Set(
      (project.workspaceRepositories ?? []).flatMap((identity) =>
        identity.canonicalKey ? [identity.canonicalKey.toLowerCase()] : [],
      ),
    ),
  ];
}

/** Which server lists each repository: the preferred one where it has it, else the first. */
function repositoryOwners(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId: EnvironmentId | null | undefined,
): Map<string, EnvironmentId> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  const owner = new Map<string, EnvironmentId>();
  for (const project of projects) {
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    for (const key of repositoryKeysOf(project)) {
      const current = owner.get(key);
      if (current === undefined) {
        owner.set(key, project.environmentId);
        continue;
      }
      if (current === preferredEnvironmentId) continue;
      if (
        project.environmentId === preferredEnvironmentId ||
        environmentRank < (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
      ) {
        owner.set(key, project.environmentId);
      }
    }
  }
  return owner;
}

/**
 * Two servers can hold the same repository, and both would list the same pull requests, so one
 * copy is picked by its repository key. A project rooted in a repository another server lists is
 * left out. A folder holding checkouts is kept while any of them is its own to list, and the
 * rest are named in `excludeRepositories` for its server to skip.
 *
 * A project with no identity is never de-duplicated: nothing proves it is a copy of anything, and
 * dropping it would lose its rows outright.
 */
export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
): Map<EnvironmentId, EnvironmentAssignment> {
  const owner = repositoryOwners(projects, environmentIds, preferredEnvironmentId);
  const reading = new Set(environmentIds);
  const assignment = new Map<
    EnvironmentId,
    { projectIds: ProjectId[]; excludeRepositories: Set<string> }
  >();
  for (const project of projects) {
    if (!reading.has(project.environmentId)) continue;
    const keys = repositoryKeysOf(project);
    const others = keys.filter((key) => owner.get(key) !== project.environmentId);
    if (keys.length > 0 && others.length === keys.length) continue;
    let listed = assignment.get(project.environmentId);
    if (listed === undefined) {
      listed = { projectIds: [], excludeRepositories: new Set() };
      assignment.set(project.environmentId, listed);
    }
    listed.projectIds.push(project.id);
    for (const key of others) listed.excludeRepositories.add(key);
  }
  return new Map(
    [...assignment].map(([environmentId, listed]) => [
      environmentId,
      {
        projectIds: listed.projectIds,
        excludeRepositories: [...listed.excludeRepositories].toSorted(),
      },
    ]),
  );
}

/** What one server is asked to list. */
export interface EnvironmentAssignment {
  readonly projectIds: ReadonlyArray<ProjectId>;
  /** Repository keys another server lists, among this one's folders' checkouts. */
  readonly excludeRepositories: ReadonlyArray<string>;
}

/** A copy of the repository the reader could act on, named by the server holding it. */
export interface PickableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly machine?: EnvironmentMachineKind;
}

/**
 * Which servers a pull request could be acted on, given the one it is listed under.
 *
 * Listing picks a single server per repository so each pull request appears once; acting is a
 * different question. Checking the branch out, or handing it to a thread, happens wherever the
 * reader means to work — and the copy the listing happened not to pick is just as real.
 *
 * Empty where there is no choice to offer: one server, no repository identity to match copies by,
 * or projects not read yet. The caller renders nothing then, so a lone server keeps the surface it
 * has always had.
 */
export function resolvePickableEnvironments(
  current: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    /** The pull request's repository, which picks a folder's checkout of it. */
    readonly repository?: string;
  },
  projects: ReadonlyArray<AssignableProject & { readonly workspaceRoot: string }>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly machine?: EnvironmentMachineKind;
  }>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const repositoryPath = current.repository?.toLowerCase();
  const key =
    own === undefined
      ? undefined
      : (repositoryKey(own) ??
        (repositoryPath === undefined
          ? undefined
          : repositoryKeysOf(own).find((candidate) => candidate.endsWith(`/${repositoryPath}`))));
  const ownEnvironment = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  );
  if (own === undefined || !key || ownEnvironment === undefined) return [];
  const ownCopy = copyIn(own, key);
  if (ownCopy === null) return [];
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    // One entry per server, whichever copy comes first: a server holding two worktrees of the
    // repository is still one place to act, and what is being picked here is the server.
    for (const project of projects) {
      if (project.environmentId !== environment.environmentId) continue;
      const copy = copyIn(project, key);
      if (copy === null) continue;
      return [
        {
          environmentId: environment.environmentId,
          projectId: project.id,
          workspaceRoot: copy.workspaceRoot,
          label: environment.label,
          ...(environment.machine === undefined ? {} : { machine: environment.machine }),
        },
      ];
    }
    return [];
  });
  if (others.length === 0) return [];
  // The panel's own server first: it is what everything else on the panel is showing, so it is
  // also what acting means until the reader says otherwise.
  return [
    {
      environmentId: current.environmentId,
      projectId: own.id,
      workspaceRoot: ownCopy.workspaceRoot,
      label: ownEnvironment.label,
      ...(ownEnvironment.machine === undefined ? {} : { machine: ownEnvironment.machine }),
    },
    ...others,
  ];
}

/** Where a project holds the repository: its own root, or a folder's checkout of it. */
function copyIn(
  project: AssignableProject & { readonly workspaceRoot: string },
  key: string,
): { readonly workspaceRoot: string } | null {
  if (repositoryKey(project) === key) return { workspaceRoot: project.workspaceRoot };
  if (project.repositoryIdentity != null) return null;
  const checkout = project.workspaceRepositories?.find(
    (identity) => identity.canonicalKey?.toLowerCase() === key,
  );
  return checkout === undefined
    ? null
    : { workspaceRoot: checkout.rootPath ?? project.workspaceRoot };
}
