import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { discoverManifests } from "./manifests.ts";

class ManifestRepositoryError extends Schema.TaggedError<ManifestRepositoryError>()(
  "ManifestRepositoryError",
  {
    directory: Schema.String,
    reason: Schema.Literals(["not-found", "failed", "timeout"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `No Git repositories found in ${this.directory}.`;
      case "failed":
        return `Could not pull ${this.directory}. Check its upstream, credentials, and local changes.`;
      case "timeout":
        return `Pull timed out for ${this.directory}.`;
    }
  }
}

/** Pulls each manifest repository once, including roots that are inside a checkout. */
export const pullManifestRepositories = Effect.fn("desktop.agentctl.pullManifestRepositories")(
  function* (folder: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = (directory: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", ["-C", directory, ...args], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "ignore",
              env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
              extendEnv: true,
            }),
          );
          const [output, exitCode] = yield* Effect.all(
            [Stream.runCollect(handle.stdout), handle.exitCode],
            { concurrency: "unbounded" },
          );
          const decoder = new TextDecoder();
          const stdout =
            output.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
            decoder.decode();
          return { stdout: stdout.trim(), exitCode };
        }),
      ).pipe(
        Effect.mapError(
          (cause) => new ManifestRepositoryError({ directory, reason: "failed", cause }),
        ),
        Effect.timeoutOrElse({
          duration: "2 minutes",
          orElse: () => Effect.fail(new ManifestRepositoryError({ directory, reason: "timeout" })),
        }),
      );

    const manifests = yield* discoverManifests([folder]);
    const candidates = new Set([folder, ...manifests.map((manifest) => manifest.repository)]);
    const repositories = new Set<string>();
    for (const candidate of candidates) {
      const result = yield* run(candidate, ["rev-parse", "--show-toplevel"]);
      if (result.exitCode === 0) repositories.add(result.stdout);
    }
    if (repositories.size === 0) {
      return yield* new ManifestRepositoryError({ directory: folder, reason: "not-found" });
    }
    for (const directory of repositories) {
      // Override rebase and autostash preferences: this action only fast-forwards.
      const result = yield* run(directory, ["pull", "--ff-only", "--no-rebase", "--no-autostash"]);
      if (result.exitCode !== 0) {
        return yield* new ManifestRepositoryError({
          directory,
          reason: "failed",
          cause: result.exitCode,
        });
      }
    }
  },
);
