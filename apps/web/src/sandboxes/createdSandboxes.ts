import { useSyncExternalStore } from "react";

// Sandboxes this window created, kept in view in the sidebar until a thread
// is started in one or it is dismissed. Lost on reload, like the dialog itself.
let created: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>) {
  created = next;
  for (const listener of listeners) listener();
}

export function rememberCreatedSandbox(name: string) {
  if (!created.has(name)) emit(new Set([...created, name]));
}

export function forgetCreatedSandbox(name: string) {
  if (!created.has(name)) return;
  const next = new Set(created);
  next.delete(name);
  emit(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCreatedSandboxes(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => created);
}
