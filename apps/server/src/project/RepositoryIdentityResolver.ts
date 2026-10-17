import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { explicitBareRepositoryEnv } from "../vcs/VcsProcess.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Minute-by-minute sweeps need cached hits; clone, publish and PR discovery force refresh.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
// Each repository costs three git probes per positive TTL, so a folder of hundreds of
// clones is read as its first 64 rather than spawning git for every one.
const MAX_WORKSPACE_REPOSITORIES = 64;

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
    /**
     * The checkouts in a folder's immediate children, such as an agentctl Sandbox's working
     * directory, skipping dot-folders like `.worktrees` and symlinks. Empty for a folder inside a
     * repository, so repository-rooted projects keep one identity.
     */
    readonly resolveWorkspace: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<RepositoryIdentity>>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

// Local paths such as GitButler's gb-local=. would give unrelated repos the same identity.
function isLocalRemoteUrl(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  if (/^[a-z]:[\\/]/i.test(url)) return true;
  // Git treats `host:path` as scp-style only when the colon precedes any slash.
  const colonIndex = url.indexOf(":");
  const slashIndex = url.search(/[\\/]/);
  return colonIndex === -1 || (slashIndex !== -1 && slashIndex < colonIndex);
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (
      direction !== "fetch" ||
      remoteName.length === 0 ||
      remoteUrl.length === 0 ||
      isLocalRemoteUrl(remoteUrl)
    ) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

/**
 * The remote `gh repo set-default` marked and the repository it names: `base` for the remote's
 * own, or `owner/name` on its host for one that is no remote here. More than one mark leaves gh
 * to prompt, so it reads as none.
 */
function parseGhDefault(
  stdout: string,
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const marks = stdout
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+(\S+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && remotes.has(match[1]!));
  const [mark, ...others] = marks;
  if (mark === undefined || others.length > 0) return null;
  const remoteName = mark[1]!;
  const remoteUrl = remotes.get(remoteName)!;
  if (mark[2] === "base") return { remoteName, remoteUrl };
  const [owner, name, ...rest] = mark[2]!.split("/");
  const [host] = normalizeGitRemoteUrl(remoteUrl).split("/");
  return owner && name && host && rest.length === 0
    ? { remoteName, remoteUrl: `https://${host}/${owner}/${name}.git` }
    : null;
}

/**
 * The remote whose repository the checkout's pull requests go to: the one `gh repo set-default`
 * chose, otherwise `upstream`, as a fork's usually go there, then `origin`.
 */
function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
  ghDefault: { readonly remoteName: string; readonly remoteUrl: string } | null,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  if (ghDefault !== null) return ghDefault;
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function repositoryPathOf(canonicalKey: string, remoteUrl: string): string {
  const canonicalPath = canonicalKey.split("/").slice(1).join("/");
  const displayPath = repositoryPathFromRemoteUrl(remoteUrl);
  return displayPath?.toLowerCase() === canonicalPath ? displayPath : canonicalPath;
}

function buildRepositoryOrigin(
  originUrl: string | undefined,
  canonicalKey: string,
): RepositoryIdentity["origin"] {
  if (!originUrl) return undefined;
  const originKey = sourceControlDefinitions.repositoryKeyFromRemote(originUrl);
  if (originKey === canonicalKey) return undefined;
  const displayName = repositoryPathOf(originKey, originUrl);
  return { canonicalKey: originKey, remoteUrl: originUrl, ...(displayName ? { displayName } : {}) };
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly originUrl: string | undefined;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = sourceControlDefinitions.repositoryKeyFromRemote(input.remoteUrl);
  const sourceControlProvider = sourceControlDefinitions.recognizeRemote(input.remoteUrl);
  const repositoryPath = repositoryPathOf(canonicalKey, input.remoteUrl);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const origin = buildRepositoryOrigin(input.originUrl, canonicalKey);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    ...(origin ? { origin } : {}),
  };
}

class RepositoryIdentityCacheKey extends Data.Class<{
  readonly rootPath: string;
  readonly isBare: boolean;
}> {}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const env = explicitBareRepositoryEnv(process.env, yield* HostProcess.Platform);

    // git is always a real executable; cmd shell mode would split spaced paths on re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        env,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.timedOut) {
      return null;
    }
    if (topLevelResult.value.code === 0) {
      const rootPath = topLevelResult.value.stdout.trim();
      return rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: false })
        : null;
    }

    // Explicit Git directories preserve safe.bareRepository=explicit for both layouts.
    for (const gitDir of [".", ".git"]) {
      const bareResult = yield* processRunner
        .run({
          command: "git",
          args: [
            "-C",
            cwd,
            `--git-dir=${gitDir}`,
            "rev-parse",
            "--is-bare-repository",
            "--absolute-git-dir",
          ],
          env,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (bareResult._tag === "None" || bareResult.value.timedOut) return null;
      if (bareResult.value.code !== 0) continue;

      const [isBare, rootPath = ""] = bareResult.value.stdout
        .split("\n")
        .map((line) => line.trim());
      // A checkout's .git directory contains remotes but is not a project root.
      return isBare === "true" && rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: true })
        : null;
    }
    return null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: RepositoryIdentityCacheKey,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const gitDir = cacheKey.isBare ? ["--git-dir=."] : [];
  const env = explicitBareRepositoryEnv(process.env, yield* HostProcess.Platform);
  const [remoteResult, ghDefaultResult] = yield* Effect.all(
    [
      processRunner
        .run({
          command: "git",
          args: ["-C", cacheKey.rootPath, ...gitDir, "remote", "-v"],
          env,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option),
      // Exits 1 when gh never set a default; that reads as none.
      processRunner
        .run({
          command: "git",
          args: [
            "-C",
            cacheKey.rootPath,
            ...gitDir,
            "config",
            "--get-regexp",
            "^remote\\..*\\.gh-resolved$",
          ],
          env,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option),
    ],
    { concurrency: 2 },
  );
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remotes = parseRemoteFetchUrls(remoteResult.value.stdout);
  const ghDefault =
    ghDefaultResult._tag === "Some" && ghDefaultResult.value.code === 0
      ? parseGhDefault(ghDefaultResult.value.stdout, remotes)
      : null;
  const remote = pickPrimaryRemote(remotes, ghDefault);
  return remote
    ? buildRepositoryIdentity({
        ...remote,
        originUrl: remotes.get("origin"),
        rootPath: cacheKey.rootPath,
      })
    : null;
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<string, RepositoryIdentityCacheKey | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<
    RepositoryIdentityCacheKey,
    RepositoryIdentity | null
  >(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  // Read on the negative TTL: the answer changes when a checkout is cloned or removed.
  const workspaceCheckoutCache = yield* Cache.makeWith<string, ReadonlyArray<string>>(
    (cwd) =>
      fileSystem.readDirectory(cwd).pipe(
        Effect.flatMap((names) =>
          Effect.filter(
            names.filter((name) => !name.startsWith(".")),
            // A `.git` directory for a clone, or a `.git` file for a worktree. A symlink could
            // lead outside the folder, so only real child folders count.
            (name) =>
              fileSystem.readLink(path.join(cwd, name)).pipe(
                Effect.as(false),
                Effect.catch(() =>
                  fileSystem
                    .exists(path.join(cwd, name, ".git"))
                    .pipe(Effect.orElseSucceed(() => false)),
                ),
              ),
            { concurrency: 16 },
          ),
        ),
        Effect.map((names) =>
          // Sorted after the checks: a concurrent filter keeps names in the order they finish.
          names
            .toSorted()
            .slice(0, MAX_WORKSPACE_REPOSITORIES)
            .map((name) => path.join(cwd, name)),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: () => options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL,
    },
  );

  const resolveWorkspace: RepositoryIdentityResolver["Service"]["resolveWorkspace"] =
    Effect.fnUntraced(function* (cwd, options) {
      if (options?.refresh) {
        yield* Cache.invalidate(repositoryRootCache, cwd);
        yield* Cache.invalidate(workspaceCheckoutCache, cwd);
      }
      if ((yield* Cache.get(repositoryRootCache, cwd)) !== null) return [];
      const checkouts = yield* Cache.get(workspaceCheckoutCache, cwd);
      const identities = yield* Effect.forEach(
        checkouts,
        (checkout) => resolve(checkout, options),
        { concurrency: 4 },
      );
      return identities.filter((identity) => identity !== null);
    });

  return RepositoryIdentityResolver.of({ resolve, resolveWorkspace });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
