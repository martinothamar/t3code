import { createFileRoute } from "@tanstack/react-router";

import { SandboxesPage } from "../sandboxes/SandboxesPage";

export const Route = createFileRoute("/sandboxes")({
  component: SandboxesPage,
});
