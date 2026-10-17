// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git fixtures are prepared independently of the Effect process code under test.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { pullManifestRepositories, resolveManifestRepository } from "./pullManifestRepositories.ts";

const git = (directory: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3 manifest pull " });
  const upstream = path.join(home, "upstream");
  const root = path.join(home, "manifests");
  const checkout = path.join(root, "app");
  yield* fs.makeDirectory(upstream);
  yield* fs.makeDirectory(root);
  git(upstream, "init", "-b", "main");
  yield* fs.makeDirectory(path.join(upstream, "agents"));
  const manifest = path.join(upstream, "agents", "agent.yaml");
  yield* fs.writeFileString(manifest, "metadata:\n  name: original\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "initial");
  git(root, "clone", upstream, checkout);
  const advance = Effect.gen(function* () {
    yield* fs.writeFileString(manifest, "metadata:\n  name: updated\n");
    yield* fs.writeFileString(
      path.join(upstream, "agents", "agent.nested.yaml"),
      "metadata:\n  name: nested\n",
    );
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "update manifests");
  });
  return { fs, path, home, upstream, root, checkout, advance };
});

describe("pullManifestRepositories", () => {
  it.effect(
    "identifies actual checkouts, nested folders, and worktrees without treating parent folders as repositories",
    () =>
      Effect.gen(function* () {
        const { checkout, root, home, fs, path } = yield* fixture;
        const repository = yield* resolveManifestRepository(checkout);
        assert.isNotNull(repository);
        assert.strictEqual(
          yield* resolveManifestRepository(path.join(checkout, "agents")),
          repository,
        );
        assert.strictEqual(yield* resolveManifestRepository(root), null);
        const fake = path.join(home, "fake");
        yield* fs.makeDirectory(path.join(fake, ".git"), { recursive: true });
        assert.strictEqual(yield* resolveManifestRepository(fake), null);
        const worktree = path.join(home, "linked");
        git(checkout, "worktree", "add", "-b", "linked", worktree);
        const linkedRepository = yield* resolveManifestRepository(worktree);
        assert.isNotNull(linkedRepository);
        assert.notStrictEqual(linkedRepository, repository);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("pulls multiple repositories under a manifest folder and discovers new variants", () =>
    Effect.gen(function* () {
      const { root, checkout, upstream, advance, fs, path } = yield* fixture;
      const other = path.join(root, "other");
      git(root, "clone", upstream, other);
      yield* advance;
      yield* pullManifestRepositories(root);
      for (const repo of [checkout, other]) {
        assert.strictEqual(git(repo, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
        assert.isTrue(yield* fs.exists(path.join(repo, "agents", "agent.nested.yaml")));
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("pulls when the configured folder is inside a repository", () =>
    Effect.gen(function* () {
      const { checkout, upstream, advance, path } = yield* fixture;
      yield* advance;
      yield* pullManifestRepositories(path.join(checkout, "agents"));
      assert.strictEqual(git(checkout, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
      // Pulling again when up to date also succeeds.
      yield* pullManifestRepositories(checkout);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "leaves local edits in place when they block the pull, even with autostash configured",
    () =>
      Effect.gen(function* () {
        const { checkout, advance, fs, path } = yield* fixture;
        git(checkout, "config", "pull.rebase", "true");
        git(checkout, "config", "rebase.autoStash", "true");
        const manifest = path.join(checkout, "agents", "agent.yaml");
        const head = git(checkout, "rev-parse", "HEAD");
        yield* fs.writeFileString(manifest, "local changes\n");
        yield* advance;
        const result = yield* Effect.result(pullManifestRepositories(checkout));
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(git(checkout, "rev-parse", "HEAD"), head);
        assert.strictEqual(yield* fs.readFileString(manifest), "local changes\n");
        assert.strictEqual(git(checkout, "stash", "list"), "");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses divergent history without merging or rebasing local commits", () =>
    Effect.gen(function* () {
      const { checkout, advance, fs, path } = yield* fixture;
      yield* fs.writeFileString(path.join(checkout, "local.txt"), "local\n");
      git(checkout, "add", ".");
      git(checkout, "commit", "-m", "local work");
      const head = git(checkout, "rev-parse", "HEAD");
      yield* advance;
      const result = yield* Effect.result(pullManifestRepositories(checkout));
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(git(checkout, "rev-parse", "HEAD"), head);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports folders without Git repositories", () =>
    Effect.gen(function* () {
      const { home, fs, path } = yield* fixture;
      const loose = path.join(home, "loose");
      yield* fs.makeDirectory(loose);
      yield* fs.writeFileString(path.join(loose, "agent.yaml"), "metadata:\n  name: loose\n");
      const result = yield* Effect.result(pullManifestRepositories(loose));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.message, `No Git repositories found in ${loose}.`);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
