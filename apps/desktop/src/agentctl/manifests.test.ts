import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { envFileKeys, envFileProblem } from "./manifests.ts";

const BASE = `apiVersion: agents.platform/v1alpha1
kind: Agent
metadata:
  name: worker
spec:
  environment:
    - name: GIT_USER_NAME
  secrets:
    - environment: GITHUB_TOKEN
      allowedHosts: [github.com]
    - environment: NPM_TOKEN
      optional: true
      allowedHosts: [registry.npmjs.org]
`;

const VARIANT = `apiVersion: agents.platform/v1alpha1
kind: AgentVariant
extends: agent.yaml
metadata:
  name: worker-small
spec:
  sandbox:
    resources:
      cpu: "2"
`;

/** A manifest folder with a base manifest and a variant that inherits its values. */
const withManifests = <A, E>(
  test: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-manifests-test-" });
    yield* fileSystem.writeFileString(path.join(directory, "agent.yaml"), BASE);
    yield* fileSystem.writeFileString(path.join(directory, "agent.small.yaml"), VARIANT);
    return yield* test(directory);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("envFileProblem", () => {
  it.effect("names what a manifest needs when there is no env file", () =>
    withManifests((directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const problem = yield* envFileProblem(path.join(directory, "agent.small.yaml"), null);
        assert.include(problem ?? "", "GIT_USER_NAME, GITHUB_TOKEN");
        assert.notInclude(problem ?? "", "NPM_TOKEN");
      }),
    ),
  );

  it.effect("names the keys an env file is missing, and accepts one that has them", () =>
    withManifests((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const envFile = path.join(directory, "worker.env");
        yield* fileSystem.writeFileString(envFile, "GIT_USER_NAME=Worker\nGITHUB_TOKEN=\n");
        const manifest = path.join(directory, "agent.small.yaml");
        assert.strictEqual(
          yield* envFileProblem(manifest, envFile),
          `${envFile} does not set GITHUB_TOKEN.`,
        );
        yield* fileSystem.writeFileString(
          envFile,
          "GIT_USER_NAME=Worker\nexport GITHUB_TOKEN='x'\n",
        );
        assert.strictEqual(yield* envFileProblem(manifest, envFile), null);
      }),
    ),
  );

  it.effect("uses the .env beside the manifest by default", () =>
    withManifests((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(directory, ".env"),
          "GIT_USER_NAME=Worker\nGITHUB_TOKEN=x\n",
        );
        assert.strictEqual(yield* envFileProblem(path.join(directory, "agent.yaml"), null), null);
      }),
    ),
  );
});

describe("envFileKeys", () => {
  it("keeps only keys with a value", () => {
    assert.deepStrictEqual(
      [...envFileKeys("# comment\nA=1\nB=\nexport C=\"x\"\n  D = ''\nnot a line\n")],
      ["A", "C"],
    );
  });
});
