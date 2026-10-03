import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function UnifiedDiff({
  patch,
  action,
  disabled = false,
}: {
  patch: string;
  action?: { label: string; onStageHunk: (index: number) => void };
  disabled?: boolean;
}) {
  if (patch === "") {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">No diff for this file.</p>
    );
  }

  let hunkIndex = -1;
  return (
    <div className="overflow-x-auto border-y border-border bg-surface-recessed text-[12px] leading-5">
      <pre className="min-w-max py-1 font-mono">
        {patch.split("\n").map((line, index) => {
          const isHunk = line.startsWith("@@ ");
          if (isHunk) hunkIndex += 1;
          const isAddition = line.startsWith("+") && !line.startsWith("+++");
          const isRemoval = line.startsWith("-") && !line.startsWith("---");
          const isMeta =
            line.startsWith("diff --git ") ||
            line.startsWith("index ") ||
            line.startsWith("--- ") ||
            line.startsWith("+++ ") ||
            line.startsWith("new file mode ") ||
            line.startsWith("deleted file mode ");
          return (
            <div
              key={`${index}-${line}`}
              className={cn(
                "min-h-5 px-3",
                isHunk && "flex items-center justify-between gap-4 border-y border-border bg-background py-0.5 text-muted-foreground",
                isAddition && "bg-diff-added/10 text-diff-added",
                isRemoval && "bg-diff-removed/10 text-diff-removed",
                isMeta && "text-muted-foreground",
              )}
            >
              <code className="whitespace-pre">{line || " "}</code>
              {isHunk && action !== undefined ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => action.onStageHunk(hunkIndex)}
                  className="hidden shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-foreground hover:bg-state-hover disabled:opacity-40 md:inline-flex"
                >
                  <Icon name="Plus" aria-hidden className="size-3" />
                  {action.label}
                </button>
              ) : null}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
