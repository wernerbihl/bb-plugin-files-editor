import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { extensionOf, glyphTone, type GlyphTone } from "@/lib/file-kind";

// Mid-range hues only: BB's palettes are user-selectable rather than a plain
// light/dark pair, so a `dark:` variant would not track the active theme.
const TONE_CLASS: Readonly<Record<GlyphTone, string>> = {
  code: "text-sky-500",
  config: "text-amber-500",
  markup: "text-orange-500",
  style: "text-violet-500",
  doc: "text-emerald-500",
  media: "text-pink-500",
  plain: "text-muted-foreground",
};

/** The coloured file/folder mark on an explorer row. */
export function FileGlyph({
  path,
  kind,
  isExpanded,
  className,
}: {
  path: string;
  kind: "file" | "directory";
  isExpanded?: boolean;
  className?: string;
}) {
  if (kind === "directory") {
    return (
      <Icon
        name={isExpanded === true ? "FolderOpen" : "Folder"}
        aria-hidden
        className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  const badge = fileBadge(path);
  return (
    <span
      aria-hidden
      className={cn("relative inline-grid size-4 shrink-0 place-items-center", className)}
    >
      <Icon name="File" aria-hidden className={cn("size-4", TONE_CLASS[glyphTone(path)])} />
      {badge !== null ? (
        <span className="absolute -right-0.5 -bottom-0.5 rounded-[2px] bg-background px-px text-[5px] leading-[6px] font-black text-foreground">
          {badge}
        </span>
      ) : null}
    </span>
  );
}

function fileBadge(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName: Readonly<Record<string, string>> = {
    ".env": "ENV",
    ".gitignore": "GIT",
    dockerfile: "D",
    makefile: "M",
  };
  const knownName = byName[name];
  if (knownName !== undefined) return knownName;
  const byExtension: Readonly<Record<string, string>> = {
    astro: "A",
    c: "C",
    cpp: "C++",
    css: "CSS",
    go: "GO",
    html: "<>",
    java: "JV",
    js: "JS",
    jsx: "JSX",
    json: "{}",
    jsonc: "{}",
    md: "M",
    mdx: "MDX",
    mjs: "JS",
    png: "IMG",
    py: "PY",
    rs: "RS",
    scss: "SC",
    sh: "SH",
    sql: "SQL",
    svelte: "S",
    ts: "TS",
    tsx: "TSX",
    vue: "V",
    yaml: "YML",
    yml: "YML",
  };
  return byExtension[extensionOf(path)] ?? null;
}
