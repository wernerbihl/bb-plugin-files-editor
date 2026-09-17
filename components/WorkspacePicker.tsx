import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ScopeRef } from "@/lib/route";
import { sameScope } from "@/lib/route";
import { defaultOptionFor, groupWorkspaces } from "@/lib/workspaces";
import type { ResolvedScope, WorkspaceOption, rpcContract } from "../server.js";

/**
 * Picks what the explorer shows, as two dependent controls: the project, then
 * the checkout or worktree inside it. One flat list mixed both together and
 * repeated the project's name on every row, which got unreadable once a
 * project had more than a couple of worktrees.
 *
 * Vendored shadcn Select keeps both controls on the host's BB recipe —
 * trigger, popover, and items — instead of the browser's native dropdown.
 */
export function WorkspacePicker({
  current,
  onSelect,
}: {
  current: ResolvedScope | null;
  onSelect: (scope: ScopeRef) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [options, setOptions] = useState<WorkspaceOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("workspaces")
      .then((result) => {
        if (!cancelled) setOptions(result.workspaces);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const groups = useMemo(() => groupWorkspaces(options ?? []), [options]);

  // A scope reached by thread id is not one of the listed options, and its
  // project may not be listed either. Track both so neither control ever reads
  // as "nothing selected" while a workspace is open.
  const listedHere = (options ?? []).some(
    (option) => current !== null && sameScope(option.ref, current.ref),
  );
  const selectedProjectId = current?.projectId ?? "";
  const knownProject = groups.some(
    (group) => group.projectId === selectedProjectId,
  );
  const activeGroup = groups.find(
    (group) => group.projectId === selectedProjectId,
  );

  const isLoading = options === null;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <PickerField icon="Folder" label="Project" title="Project">
        <Select
          value={selectedProjectId === "" ? undefined : selectedProjectId}
          disabled={isLoading}
          onValueChange={(value) => {
            const next = defaultOptionFor(
              groups.find((group) => group.projectId === value),
            );
            // Landing on the checkout keeps one click from stranding the user
            // on a project with nothing selected inside it.
            if (next !== null) onSelect(next.ref);
          }}
        >
          <SelectTrigger
            aria-label="Project"
            className="h-7 bg-background py-1 pl-7 text-xs max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-base [&>span]:truncate"
          >
            <SelectValue
              placeholder={
                isLoading
                  ? "Loading…"
                  : current === null
                    ? "Choose a project…"
                    : "Select project"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {current !== null && !knownProject ? (
              <SelectItem value={selectedProjectId}>
                {current.label}
              </SelectItem>
            ) : null}
            {groups.map((group) => (
              <SelectItem key={group.projectId} value={group.projectId}>
                {group.projectName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PickerField>

      <PickerField
        icon={current?.environmentId === null ? "Folder" : "GitBranch"}
        label="Workspace"
        title="Workspace"
      >
        <Select
          value={current === null ? undefined : keyOf(current.ref)}
          disabled={isLoading || current === null}
          onValueChange={(value) => {
            const parsed = parseKey(value);
            if (parsed !== null) onSelect(parsed);
          }}
        >
          <SelectTrigger
            aria-label="Workspace"
            className="h-7 bg-background py-1 pl-7 text-xs max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-base [&>span]:truncate"
          >
            <SelectValue placeholder={current === null ? "—" : "Select workspace"} />
          </SelectTrigger>
          <SelectContent>
            {current !== null && !listedHere ? (
              <SelectItem value={keyOf(current.ref)}>
                {current.sublabel}
              </SelectItem>
            ) : null}
            {(activeGroup?.options ?? []).map((option) => (
              <SelectItem key={keyOf(option.ref)} value={keyOf(option.ref)}>
                {option.sublabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PickerField>
    </div>
  );
}

function PickerField({
  icon,
  title,
  children,
}: {
  icon: "Folder" | "GitBranch";
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-w-0 items-center" title={title}>
      <Icon
        name={icon}
        aria-hidden
        className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function keyOf(ref: ScopeRef): string {
  return `${ref.kind}:${ref.id}`;
}

function parseKey(value: string): ScopeRef | null {
  const separator = value.indexOf(":");
  if (separator === -1) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (id === "") return null;
  if (kind !== "thread" && kind !== "environment" && kind !== "project") {
    return null;
  }
  return { kind, id };
}
