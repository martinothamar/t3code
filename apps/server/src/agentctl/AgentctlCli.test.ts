import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as AgentctlCli from "./AgentctlCli.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "agentctl Windows launcher",
  () => {
    it.effect("discovers agents and preserves manifest arguments through a PATH cmd shim", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3 agentctl " });
        const scriptPath = path.join(directory, "agentctl.cjs");
        const argumentsPath = path.join(directory, "arguments.json");
        const agents = [{ metadata: { name: "worker" }, spec: {} }];
        yield* fs.writeFileString(
          scriptPath,
          `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(${JSON.stringify(JSON.stringify(agents))});
`,
        );
        yield* fs.writeFileString(
          path.join(directory, "agentctl.cmd"),
          `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
        );
        yield* Effect.gen(function* () {
          const cli = yield* AgentctlCli.AgentctlCli;
          expect(yield* cli.listAgents).toEqual(agents);
          expect(JSON.parse(yield* fs.readFileString(argumentsPath))).toEqual([
            "get",
            "agents",
            "-o",
            "json",
          ]);

          const manifestPath = path.join(directory, "manifests & projects", "agent.yaml");
          yield* cli.apply({ manifestPath, name: "worker-2" });
          expect(JSON.parse(yield* fs.readFileString(argumentsPath))).toEqual([
            "apply",
            "-f",
            manifestPath,
            "--name",
            "worker-2",
          ]);
        }).pipe(
          Effect.provide(AgentctlCli.layer),
          Effect.provideService(HostProcess.Environment, { PATH: directory, PATHEXT: ".CMD" }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
