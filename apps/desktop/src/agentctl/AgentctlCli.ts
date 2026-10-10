import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { AgentResourceList, SshInfo, type AgentResource } from "./agentState.ts";

// T3 talks to agentctl only through its CLI and `-o json` output. The daemon's
// control socket is private: its protocol is versioned per build.

/** agentctl is not installed, or could not be started. */
export class AgentctlUnavailableError extends Data.TaggedError("AgentctlUnavailableError")<{
  readonly message: string;
}> {}

/** agentctl ran and reported an error, already reduced to its own message. */
export class AgentctlCommandError extends Data.TaggedError("AgentctlCommandError")<{
  readonly message: string;
}> {}

export type AgentctlError = AgentctlUnavailableError | AgentctlCommandError;

export interface AgentctlApplyInput {
  readonly manifestPath: string;
  readonly name: string;
  readonly envFile: string | null;
}

export class AgentctlCli extends Context.Service<
  AgentctlCli,
  {
    readonly listAgents: Effect.Effect<ReadonlyArray<AgentResource>, AgentctlError>;
    readonly sshInfo: (name: string) => Effect.Effect<SshInfo, AgentctlError>;
    readonly start: (name: string) => Effect.Effect<void, AgentctlError>;
    readonly stop: (name: string) => Effect.Effect<void, AgentctlError>;
    readonly remove: (name: string) => Effect.Effect<void, AgentctlError>;
    /** Applies without waiting; provisioning progress shows up in `listAgents`. */
    readonly apply: (input: AgentctlApplyInput) => Effect.Effect<void, AgentctlError>;
  }
>()("@t3tools/desktop/agentctl/AgentctlCli") {}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * agentctl prints `agentctl: <message>` for every error. Provisioning output can
 * precede it on stderr, so the last such line wins.
 */
export function agentctlErrorMessage(result: CommandResult): string {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reported = lines.findLast((line) => line.startsWith("agentctl: "));
  if (reported !== undefined) return reported.slice("agentctl: ".length);
  return lines.at(-1) ?? `agentctl exited with code ${result.exitCode}`;
}

const QUERY_TIMEOUT = Duration.seconds(30);
// `start` and `stop` wait for the Sandbox; agentctl's own default is 10 minutes.
const LIFECYCLE_TIMEOUT = Duration.minutes(11);

const decodeUtf8 = (chunks: ReadonlyArray<Uint8Array>) => {
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
};

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = (args: ReadonlyArray<string>, timeout: Duration.Duration) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("agentctl", args, {
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
            }),
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new AgentctlUnavailableError({
                  message: `Could not run agentctl: ${error.message}`,
                }),
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (error) => new AgentctlCommandError({ message: `agentctl failed: ${error.message}` }),
          ),
        );
        return {
          exitCode: exitCode as unknown as number,
          stdout: decodeUtf8(stdout),
          stderr: decodeUtf8(stderr),
        } satisfies CommandResult;
      }),
    ).pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AgentctlCommandError({
                message: `agentctl ${args[0]} timed out after ${Duration.format(timeout)}`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const runChecked = (args: ReadonlyArray<string>, timeout = QUERY_TIMEOUT) =>
    run(args, timeout).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(new AgentctlCommandError({ message: agentctlErrorMessage(result) })),
      ),
    );

  const runJson = <A>(
    decode: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
    args: ReadonlyArray<string>,
  ) =>
    runChecked(args).pipe(
      Effect.flatMap((stdout) =>
        decode(stdout).pipe(
          Effect.mapError(
            (error) =>
              new AgentctlCommandError({
                message: `Unexpected agentctl ${args[0]} output: ${error.message}`,
              }),
          ),
        ),
      ),
    );

  return AgentctlCli.of({
    listAgents: runJson(Schema.decodeEffect(Schema.fromJsonString(AgentResourceList)), [
      "get",
      "agents",
      "-o",
      "json",
    ]),
    sshInfo: (name) =>
      runJson(Schema.decodeEffect(Schema.fromJsonString(SshInfo)), [
        "ssh-info",
        name,
        "-o",
        "json",
      ]),
    start: (name) => runChecked(["start", `agent/${name}`], LIFECYCLE_TIMEOUT).pipe(Effect.asVoid),
    stop: (name) => runChecked(["stop", `agent/${name}`], LIFECYCLE_TIMEOUT).pipe(Effect.asVoid),
    remove: (name) => runChecked(["delete", `agent/${name}`]).pipe(Effect.asVoid),
    apply: ({ manifestPath, name, envFile }) =>
      runChecked([
        "apply",
        "-f",
        manifestPath,
        "--name",
        name,
        ...(envFile === null ? [] : ["--env-file", envFile]),
      ]).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AgentctlCli, make);
