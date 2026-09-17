import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface FindBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (next: boolean) => void;
  /** 0-based index of the selected match, or -1 when nothing is selected. */
  index: number;
  total: number;
  truncated: boolean;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  /** Bumped by the surface to re-focus and select the field on a repeat ⌘F. */
  focusRequest: number;
}

/**
 * Find within the open file. Sits directly above the content so the match
 * counter is beside the text it counts.
 */
export function FindBar({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  index,
  total,
  truncated,
  onStep,
  onClose,
  focusRequest,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    // Selecting rather than appending matches every editor: a second ⌘F with
    // the bar already open replaces the previous query as you type.
    input.select();
  }, [focusRequest]);

  const hasQuery = query !== "";
  const status = !hasQuery
    ? ""
    : total === 0
      ? "No results"
      : `${index + 1} of ${total}${truncated ? "+" : ""}`;

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-recessed px-2 py-1.5">
      <div className="relative flex min-w-0 flex-1 items-center">
        <Icon
          name="Search"
          aria-hidden
          className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          value={query}
          type="text"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Find in file"
          aria-label="Find in file"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            // The bar owns these keys; without stopping them the surface's own
            // ⌘F / Escape handlers would fire a second time.
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              onStep(event.shiftKey ? -1 : 1);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          className="h-7 bg-background pr-2 pl-7 text-xs"
        />
      </div>

      <button
        type="button"
        aria-label="Match case"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        className={cn(
          "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md font-mono text-[11px] leading-none transition-colors",
          "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          caseSensitive && "bg-state-active text-foreground",
        )}
      >
        Aa
      </button>

      <span
        role="status"
        className="w-[5.5rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
      >
        {status}
      </span>

      <StepButton
        icon="ChevronUp"
        label="Previous match"
        disabled={total === 0}
        onClick={() => onStep(-1)}
      />
      <StepButton
        icon="ChevronDown"
        label="Next match"
        disabled={total === 0}
        onClick={() => onStep(1)}
      />
      <StepButton icon="X" label="Close find" onClick={onClose} />
    </div>
  );
}

function StepButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: "ChevronUp" | "ChevronDown" | "X";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3.5" />
    </button>
  );
}
