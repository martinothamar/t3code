import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { enrichProjectShell, folderRepositories, projectCoversPath } from "./folderRepositories.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const identity = (repository: string, rootPath?: string): RepositoryIdentity => ({
  canonicalKey: `github.com/${repository}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://github.com/${repository}.git`,
  },
  provider: SourceControlProviderKind.make("github"),
  displayName: repository,
  ...(rootPath === undefined ? {} : { rootPath }),
});

// A Sandbox's folder: one repository found inside it, and one someone added from elsewhere.
const folder = {
  id: ProjectId.make("sandbox"),
  title: "sandbox",
  workspaceRoot: "/workspace",
  trackedFolders: [
    { path: "/workspace/app", name: "app", discovered: true },
    { path: "/home/user/lib", name: "lib" },
    { path: "/workspace/notes", name: "notes", discovered: true },
  ],
} as unknown as OrchestrationProjectShell;

const identities: Record<string, RepositoryIdentity> = {
  "/workspace/app": identity("acme/app"),
  "/home/user/lib": identity("acme/lib", "/home/user/lib"),
  "/repo": identity("acme/repo", "/repo"),
};

describe("folder repositories", () => {
  it.effect("resolves each folder the project tracks, found or added", () =>
    Effect.gen(function* () {
      expect(yield* folderRepositories(folder)).toEqual([
        identity("acme/app", "/workspace/app"),
        identity("acme/lib", "/home/user/lib"),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: (cwd) => Effect.succeed(identities[cwd] ?? null),
        }),
      ),
    ),
  );

  it.effect("gives a folder project's shell the identities of the folders it tracks", () =>
    Effect.gen(function* () {
      const { project } = yield* enrichProjectShell(folder);
      expect(project.repositoryIdentity).toBeNull();
      expect(project.workspaceRepositories).toEqual([
        identity("acme/app", "/workspace/app"),
        identity("acme/lib", "/home/user/lib"),
      ]);

      // A project rooted in a repository keeps that one identity, whatever it tracks.
      const rooted = yield* enrichProjectShell({
        ...folder,
        workspaceRoot: "/repo",
        workspaceRepositories: [identity("acme/stale")],
      });
      expect(rooted.project.repositoryIdentity).toEqual(identity("acme/repo", "/repo"));
      expect(rooted.project).not.toHaveProperty("workspaceRepositories");

      expect(projectCoversPath(folder, "/home/user/lib")).toBe(true);
      expect(projectCoversPath(folder, "/workspace")).toBe(true);
      expect(projectCoversPath(folder, "/elsewhere")).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          getAvailable: (path) =>
            Effect.succeed({
              repositoryIdentity: identities[path] ?? null,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
        }),
      ),
    ),
  );
});
