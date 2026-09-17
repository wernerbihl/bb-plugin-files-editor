import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  buildTree,
  filterTree,
  visibleRows,
  type FlatEntry,
  type TreeRow,
} from "@/lib/tree";
import { FileGlyph } from "./FileGlyph";

export interface ExplorerProps {
  entries: readonly FlatEntry[];
  activePath: string | null;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
  /** BB's remote listing cannot return dotfiles, so the toggle is disabled. */
  hiddenSupported: boolean;
  includeHidden: boolean;
  onToggleHidden: (next: boolean) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onQuickOpen: () => void;
  header: React.ReactNode;
}

const INDENT_PER_LEVEL_PX = 10;

/** Rows mounted at once. Beyond this the footer says how many were held back. */
const ROW_LIMIT = 600;

export function Explorer({
  entries,
  activePath,
  isLoading,
  error,
  truncated,
  hiddenSupported,
  includeHidden,
  onToggleHidden,
  onOpenFile,
  onRefresh,
  onQuickOpen,
  header,
}: ExplorerProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const filtered = useMemo(() => filterTree(tree, query), [tree, query]);

  // Reveal the active file by opening every directory above it.
  useEffect(() => {
    if (activePath === null) return;
    setExpanded((current) => {
      const ancestors = ancestorsOf(activePath);
      if (ancestors.every((ancestor) => current.has(ancestor))) return current;
      const next = new Set(current);
      for (const ancestor of ancestors) next.add(ancestor);
      return next;
    });
  }, [activePath]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath, entries.length]);

  const effectiveExpanded = useMemo(() => {
    if (filtered.expand.size === 0) return expanded;
    return new Set([...expanded, ...filtered.expand]);
  }, [expanded, filtered.expand]);

  const allRows = useMemo(
    () => visibleRows(filtered.nodes, effectiveExpanded),
    [filtered.nodes, effectiveExpanded],
  );
  // A one-letter query matches nearly every path in a large checkout. Cap what
  // is mounted rather than synchronously building tens of thousands of rows.
  const rows = useMemo(() => {
    if (allRows.length <= ROW_LIMIT) return allRows;
    const capped = allRows.slice(0, ROW_LIMIT);
    // A blind head slice can cut the row for the file that is actually open,
    // leaving the tree with no selection and the scroll-into-view a no-op.
    // Keep it, at the cost of one row from the head.
    const activeIndex = allRows.findIndex((row) => row.node.path === activePath);
    if (activeIndex >= ROW_LIMIT) capped[ROW_LIMIT - 1] = allRows[activeIndex]!;
    return capped;
  }, [activePath, allRows]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const fileCount = useMemo(
    () => entries.reduce((total, entry) => total + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-recessed">
      {header}

      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search files"
            aria-label="Search files"
            spellCheck={false}
            className="h-7 bg-background pr-2 pl-7 text-xs [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <ExplorerAction
          icon="Search"
          label="Quick open (⌘P)"
          onClick={onQuickOpen}
        />
        {hiddenSupported ? (
          <ExplorerAction
            icon={includeHidden ? "Eye" : "EyeOff"}
            label={includeHidden ? "Hide dotfiles" : "Show dotfiles"}
            isActive={includeHidden}
            onClick={() => onToggleHidden(!includeHidden)}
          />
        ) : null}
        <ExplorerAction
          icon="ArrowReloadHorizontal"
          label="Refresh files"
          isSpinning={isLoading}
          onClick={onRefresh}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {error !== null ? (
          <p className="px-3 py-2 text-xs text-destructive">{error}</p>
        ) : isLoading && entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Reading the workspace…</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {query === ""
              ? "This workspace has no files yet."
              : `No file matches “${query}”.`}
          </p>
        ) : (
          <ul role="tree" aria-label="Workspace files" className="min-w-max">
            {rows.map((row) => (
              <ExplorerRow
                key={row.node.path}
                row={row}
                query={query}
                isActive={row.node.path === activePath}
                activeRef={row.node.path === activePath ? activeRowRef : undefined}
                onToggle={toggle}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {query === ""
          ? `${fileCount.toLocaleString()} files`
          : `${filtered.matchCount.toLocaleString()} of ${fileCount.toLocaleString()} files`}
        {allRows.length > rows.length
          ? ` · showing first ${ROW_LIMIT.toLocaleString()}`
          : ""}
        {truncated ? " · listing truncated" : ""}
      </div>
    </div>
  );
}

function ExplorerRow({
  row,
  query,
  isActive,
  activeRef,
  onToggle,
  onOpenFile,
}: {
  row: TreeRow;
  query: string;
  isActive: boolean;
  activeRef?: React.RefObject<HTMLButtonElement | null>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { node, depth, isExpanded } = row;
  const isDirectory = node.kind === "directory";

  return (
    <li role="none">
      <button
        ref={activeRef}
        type="button"
        role="treeitem"
        aria-selected={isActive}
        aria-expanded={isDirectory ? isExpanded : undefined}
        title={node.path}
        onClick={() =>
          isDirectory ? onToggle(node.path) : onOpenFile(node.path)
        }
        style={{ paddingLeft: 8 + depth * INDENT_PER_LEVEL_PX }}
        className={cn(
          "flex h-6 w-full min-w-full cursor-pointer items-center gap-1.5 pr-3 text-left text-[13px]",
          "text-foreground/90 hover:bg-state-hover",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
          isActive && "bg-surface-selected text-foreground",
        )}
      >
        {isDirectory ? (
          <Icon
            name={isExpanded ? "ChevronDown" : "ChevronRight"}
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : (
          <span aria-hidden className="w-3 shrink-0" />
        )}
        <FileGlyph path={node.path} kind={node.kind} isExpanded={isExpanded} />
        <span className="truncate">
          <HighlightedText text={node.name} query={query} />
        </span>
      </button>
    </li>
  );
}

function ExplorerAction({
  icon,
  label,
  onClick,
  isActive,
  isSpinning,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isActive === true && "text-foreground",
      )}
    >
      <Icon
        name={icon}
        aria-hidden
        className={cn("size-3.5", isSpinning === true && "animate-spin")}
      />
    </button>
  );
}

/**
 * Marks the query's characters inside a name. The explorer filter is a
 * subsequence match, so matched characters can be scattered — but they are
 * emitted as contiguous runs rather than one element per character, which is
 * what keeps a filtered list of a large checkout cheap to mount.
 */
export function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const chunks = useMemo(() => highlightChunks(text, query), [text, query]);
  if (chunks === null) return <>{text}</>;

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.isMatch ? (
          <mark
            // eslint-disable-next-line react/no-array-index-key -- position IS the chunk's identity
            key={index}
            className="bg-transparent font-semibold text-primary"
          >
            {chunk.text}
          </mark>
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- same
          <span key={index}>{chunk.text}</span>
        ),
      )}
    </>
  );
}

interface HighlightChunk {
  text: string;
  isMatch: boolean;
}

/** Null when the query is empty or does not match, so the caller can bail. */
export function highlightChunks(
  text: string,
  query: string,
): HighlightChunk[] | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return null;

  // Compare and slice by code point: indexing the raw string would put the
  // mark on the wrong character in any name containing an emoji or other
  // astral character.
  const characters = [...text];
  const lowered = characters.map((character) => character.toLowerCase());
  const matched = new Set<number>();
  let cursor = 0;

  for (const needle of trimmed) {
    if (needle === " ") continue;
    const index = lowered.indexOf(needle, cursor);
    if (index === -1) return null;
    matched.add(index);
    cursor = index + 1;
  }

  const chunks: HighlightChunk[] = [];
  for (const [index, character] of characters.entries()) {
    const isMatch = matched.has(index);
    const last = chunks.at(-1);
    if (last !== undefined && last.isMatch === isMatch) last.text += character;
    else chunks.push({ text: character, isMatch });
  }
  return chunks;
}
