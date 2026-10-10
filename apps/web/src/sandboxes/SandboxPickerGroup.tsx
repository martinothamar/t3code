import { BoxIcon, PlusIcon } from "lucide-react";

import { MenuItem } from "../components/ui/menu";
import { SelectGroup, SelectGroupLabel, SelectItem } from "../components/ui/select";
import { NEW_SANDBOX_VALUE, type useSandboxPicker } from "./useSandboxPicker";

/** The location picker's Sandbox entries, after the environments that hold the project. */
export function SandboxPickerGroup({
  picker,
}: {
  readonly picker: ReturnType<typeof useSandboxPicker>;
}) {
  if (!picker.offered) return null;
  return (
    <SelectGroup>
      <SelectGroupLabel>Sandboxes</SelectGroupLabel>
      {picker.items.map((item) => (
        <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
          <span className="inline-flex w-full items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5">
              <BoxIcon className="size-3" aria-hidden="true" />
              {item.label}
            </span>
            <span className="text-muted-foreground text-xs">
              {picker.pendingName === item.label ? "Starting…" : item.status}
            </span>
          </span>
        </SelectItem>
      ))}
      <SelectItem value={NEW_SANDBOX_VALUE}>
        <span className="inline-flex items-center gap-1.5">
          <PlusIcon className="size-3" aria-hidden="true" />
          New Sandbox…
        </span>
      </SelectItem>
    </SelectGroup>
  );
}

/** The same entries for the combined "Run on / Workspace" menu. */
export function SandboxMenuItems({
  picker,
  disabled,
}: {
  readonly picker: ReturnType<typeof useSandboxPicker>;
  readonly disabled: boolean;
}) {
  if (!picker.offered) return null;
  return (
    <>
      {picker.items.map((item) => (
        <MenuItem
          key={item.value}
          disabled={disabled || item.disabled}
          onClick={() => picker.select(item.value)}
        >
          <span className="flex w-full min-w-0 items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <BoxIcon className="size-3" aria-hidden="true" />
              <span className="min-w-0 truncate">{item.label}</span>
            </span>
            <span className="shrink-0 text-muted-foreground text-xs">
              {picker.pendingName === item.label ? "Starting…" : item.status}
            </span>
          </span>
        </MenuItem>
      ))}
      <MenuItem disabled={disabled} onClick={() => picker.select(NEW_SANDBOX_VALUE)}>
        <span className="flex min-w-0 items-center gap-1.5">
          <PlusIcon className="size-3" aria-hidden="true" />
          New Sandbox…
        </span>
      </MenuItem>
    </>
  );
}

/** The state of a Sandbox environment in the picker's environment list, when it is not running. */
export function SandboxEnvironmentHint({
  picker,
  environmentId,
}: {
  readonly picker: ReturnType<typeof useSandboxPicker>;
  readonly environmentId: string;
}) {
  const hint = picker.environmentHint(environmentId);
  if (hint === null) return null;
  return <span className="ms-auto shrink-0 ps-3 text-muted-foreground text-xs">{hint}</span>;
}
