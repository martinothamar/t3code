import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Lets a fork build choose which T3 server release SSH hosts install, instead
 * of the one matching the app's own version. Set them to an upstream release
 * the fork's server code matches, or to the fork's own release downloads.
 */
export const remoteServerOverrides = Effect.gen(function* () {
  const version = yield* Config.String("T3CODE_REMOTE_SERVER_VERSION").pipe(Config.option);
  const releaseBaseUrl = yield* Config.String("T3CODE_REMOTE_SERVER_RELEASE_BASE_URL").pipe(
    Config.option,
  );
  const overrides: { -readonly [K in keyof RemoteT3RunnerOptions]: RemoteT3RunnerOptions[K] } = {};
  const trimmedVersion = Option.getOrUndefined(version)?.trim().replace(/^v/, "");
  if (trimmedVersion) overrides.archiveVersion = trimmedVersion;
  const trimmedBaseUrl = Option.getOrUndefined(releaseBaseUrl)?.trim();
  if (trimmedBaseUrl) overrides.releaseBaseUrl = trimmedBaseUrl;
  return overrides;
}).pipe(Effect.orElseSucceed((): RemoteT3RunnerOptions => ({})));

/** Applies the overrides to a release runner; a source-checkout runner is left alone. */
export function withRemoteServerOverrides(
  runner: RemoteT3RunnerOptions,
  overrides: RemoteT3RunnerOptions,
): RemoteT3RunnerOptions {
  return runner.nodeScriptPath ? runner : { ...runner, ...overrides };
}
