import type { AgentctlSandboxManifest } from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { manifestVariant } from "./agentState.ts";

// Manifests live in the user's own repositories, so discovery walks each
// configured root a few levels deep and skips what is never a manifest home.
const MAX_DEPTH = 4;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "target", "dist", "build", "vendor"]);

const ManifestMetadata = fromYaml(
  Schema.Struct({
    metadata: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  }),
);
const decodeManifestMetadata = Schema.decodeUnknownEffect(ManifestMetadata);

/** `agent.yaml` and `agent.<variant>.yaml`, in the order a picker should list them. */
export function manifestFileNames(entries: ReadonlyArray<string>): string[] {
  const names = entries.filter((name) => name === "agent.yaml" || manifestVariant(name) !== null);
  return names.toSorted((left, right) =>
    left === "agent.yaml" ? -1 : right === "agent.yaml" ? 1 : left.localeCompare(right),
  );
}

export function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  return input.startsWith("~/") ? `${homeDirectory}${input.slice(1)}` : input;
}

export const discoverManifests = Effect.fn("desktop.agentctl.discoverManifests")(function* (
  roots: ReadonlyArray<string>,
  homeDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifests: AgentctlSandboxManifest[] = [];
  const visited = new Set<string>();

  const readAgentName = (manifestPath: string) =>
    fileSystem.readFileString(manifestPath).pipe(
      Effect.flatMap(decodeManifestMetadata),
      Effect.map((manifest) => manifest.metadata?.name ?? null),
      Effect.orElseSucceed(() => null),
    );

  const walk = (directory: string, depth: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (visited.has(directory)) return;
      visited.add(directory);
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): string[] => []));
      for (const fileName of manifestFileNames(entries)) {
        const manifestPath = path.join(directory, fileName);
        manifests.push({
          path: manifestPath,
          directory,
          variant: manifestVariant(fileName),
          agentName: yield* readAgentName(manifestPath),
        });
      }
      if (depth >= MAX_DEPTH) return;
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
        const child = path.join(directory, entry);
        const info = yield* fileSystem.stat(child).pipe(Effect.option);
        if (info._tag === "Some" && info.value.type === "Directory") {
          yield* walk(child, depth + 1);
        }
      }
    });

  for (const root of roots) {
    yield* walk(path.resolve(expandHome(root, homeDirectory)), 0);
  }
  return manifests;
});

const ManifestValues = fromYaml(
  Schema.Struct({
    kind: Schema.optionalKey(Schema.String),
    extends: Schema.optionalKey(Schema.String),
    spec: Schema.optionalKey(
      Schema.Struct({
        environment: Schema.optionalKey(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({ name: Schema.String, source: Schema.optionalKey(Schema.String) }),
            ),
          ),
        ),
        secrets: Schema.optionalKey(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                environment: Schema.String,
                optional: Schema.optionalKey(Schema.Boolean),
                source: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
        ),
      }),
    ),
  }),
);
const decodeManifestValues = Schema.decodeUnknownEffect(ManifestValues);
type ManifestValues = typeof ManifestValues.Type;

// agentctl's own limit on `extends` chains.
const MAX_EXTENDS = 16;

/**
 * The env-file keys a manifest needs: its environment values and required
 * secrets. A variant inherits them through `extends` unless it sets its own,
 * since agentctl replaces arrays rather than merging them.
 */
export const requiredEnvKeys = Effect.fn("desktop.agentctl.requiredEnvKeys")(function* (
  manifestPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let environment: NonNullable<ManifestValues["spec"]>["environment"];
  let secrets: NonNullable<ManifestValues["spec"]>["secrets"];
  let current: string | null = manifestPath;
  for (let depth = 0; current !== null && depth <= MAX_EXTENDS; depth += 1) {
    const manifest: ManifestValues = yield* fileSystem
      .readFileString(current)
      .pipe(Effect.flatMap(decodeManifestValues));
    if (environment === undefined && manifest.spec?.environment !== undefined) {
      environment = manifest.spec.environment;
    }
    if (secrets === undefined && manifest.spec?.secrets !== undefined) {
      secrets = manifest.spec.secrets;
    }
    current =
      manifest.kind === "AgentVariant" && manifest.extends !== undefined
        ? path.resolve(path.dirname(current), manifest.extends)
        : null;
  }
  return [
    ...(environment ?? []).map((entry) => entry.source ?? entry.name),
    ...(secrets ?? [])
      .filter((entry) => entry.optional !== true)
      .map((entry) => entry.source ?? entry.environment),
  ];
});

/** Keys an env file sets to a non-empty value. Values are never kept. */
export function envFileKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    const value = match[2]?.trim().replace(/^(['"])(.*)\1$/, "$2") ?? "";
    if (value !== "") keys.add(match[1]);
  }
  return keys;
}

/**
 * Why applying this manifest would fail on its env file, or null when it would
 * not. agentd only reads the file after the Agent exists, so this catches the
 * mistake before a Sandbox is created that can never become Ready.
 */
export const envFileProblem = Effect.fn("desktop.agentctl.envFileProblem")(function* (
  manifestPath: string,
  envFile: string | null,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const required = yield* requiredEnvKeys(manifestPath).pipe(
    Effect.orElseSucceed((): string[] => []),
  );
  if (required.length === 0) return null;
  const file = envFile ?? path.join(path.dirname(manifestPath), ".env");
  const contents = yield* fileSystem
    .readFileString(file)
    .pipe(Effect.orElseSucceed((): string | null => null));
  const needs = required.join(", ");
  if (contents === null) {
    return envFile === null
      ? `This manifest needs ${needs} from an env file. Choose one, or create .env beside the manifest.`
      : `Cannot read ${file}. This manifest needs ${needs} from it.`;
  }
  const present = envFileKeys(contents);
  const missing = required.filter((key) => !present.has(key));
  return missing.length === 0 ? null : `${file} does not set ${missing.join(", ")}.`;
});
