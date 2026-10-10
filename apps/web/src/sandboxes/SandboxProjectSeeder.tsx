import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { useSandboxProjectSeeding } from "./sandboxProjects";
import { useSandboxes } from "./useSandboxes";

/** Adds a Sandbox's repositories as projects each time T3 connects to it. */
export function SandboxProjectSeeder() {
  const sandboxes = useSandboxes();
  return sandboxes.map((sandbox) =>
    sandbox.environmentId === null ? null : (
      <SandboxConnectionSeeder
        key={`${sandbox.name}:${sandbox.environmentId}`}
        name={sandbox.name}
        environmentId={EnvironmentId.make(sandbox.environmentId)}
      />
    ),
  );
}

function SandboxConnectionSeeder(props: {
  readonly name: string;
  readonly environmentId: EnvironmentId;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const seed = useSandboxProjectSeeding();
  // Wait for the project list, or every repository would look new.
  const ready =
    presentation?.connection.phase === "connected" && shell.data?.snapshot._tag === "Some";

  useEffect(() => {
    if (!ready) return;
    void seed({ name: props.name, environmentId: props.environmentId, includeSeeded: false }).catch(
      (error: unknown) => console.warn("Could not add Sandbox projects.", error),
    );
  }, [ready, seed, props.name, props.environmentId]);

  return null;
}
