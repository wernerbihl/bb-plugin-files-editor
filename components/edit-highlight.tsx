import type { ReactNode } from "react";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type {
  HighlighterCore,
  ThemeRegistration,
  ThemedToken,
} from "shiki/core";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { extensionOf } from "@/lib/file-kind";

import langTsx from "@shikijs/langs/tsx";
import langTypescript from "@shikijs/langs/typescript";

/**
 * Syntax highlighting for the edit pane, so switching from Read to Edit keeps
 * the colors the host viewer shows.
 *
 * BB's own viewer owns highlighting for reading and has no editable mode, so
 * the editor is a transparent textarea over a highlighted backdrop: the
 * textarea keeps the caret, selection, IME and find integration, while the
 * backdrop paints the tokens. Both layers share font, size, line height,
 * padding and wrapping, and the backdrop follows the textarea's scroll.
 *
 * Everything is statically bundled and synchronous — the plugin ships as one
 * `app.js` with no code-split chunks, so grammars are imported up front (not
 * dynamically) and the regexp engine is used (not the wasm one, which would
 * need a separate file). The theme is BB's live code theme object, so edit
 * colors always match the viewer, including palette and light/dark switches.
 */

/** Extension (lowercase, no dot) to shiki language id. TypeScript only. */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  cts: "typescript",
  mts: "typescript",
  ts: "typescript",
  tsx: "tsx",
};

/** Null when the path has no grammar: the editor stays plain text. */
export function shikiLangForPath(path: string): string | null {
  return LANG_BY_EXTENSION[extensionOf(path)] ?? null;
}

/** Above this the file edits as plain text: tokenizing stops being instant. */
export const EDIT_HIGHLIGHT_MAX_CHARS = 200_000;
export const EDIT_HIGHLIGHT_MAX_LINES = 5_000;

export function isHighlightableSize(content: string): boolean {
  if (content.length > EDIT_HIGHLIGHT_MAX_CHARS) return false;
  // One split, not a kept array: only the count matters.
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > EDIT_HIGHLIGHT_MAX_LINES) return false;
    }
  }
  return true;
}

let cached: { name: string; highlighter: HighlighterCore } | null = null;

/**
 * The edit highlighter for BB's current code theme, built once per theme and
 * reused across files and keystrokes. Null when theming is unavailable (the
 * theme resolves shortly after launch) — the editor stays plain until then.
 */
export function getEditHighlighter(
  theme: PluginCodeThemeData | null,
): HighlighterCore | null {
  if (theme === null) return null;
  if (cached !== null && cached.name === theme.name) {
    return cached.highlighter;
  }
  // BB's theme document already has the VS Code theme shape shiki accepts
  // (name, type, colors, tokenColors), so it is registered directly instead
  // of loading a bundled theme file.
  const highlighter = createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine(),
    themes: [theme as unknown as ThemeRegistration],
    langs: [langTsx, langTypescript],
  });
  if (cached !== null && typeof cached.highlighter.dispose === "function") {
    cached.highlighter.dispose();
  }
  cached = { name: theme.name, highlighter };
  return highlighter;
}

// Shiki font-style bitmask (matches VS Code's FontStyle).
const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;
const FONT_STRIKETHROUGH = 8;

function tokenStyle(
  token: ThemedToken,
  fallbackColor: string,
): React.CSSProperties {
  const style: React.CSSProperties = { color: token.color ?? fallbackColor };
  const fontStyle = token.fontStyle ?? 0;
  if ((fontStyle & FONT_ITALIC) !== 0) style.fontStyle = "italic";
  if ((fontStyle & FONT_BOLD) !== 0) style.fontWeight = "bold";
  const decorations: string[] = [];
  if ((fontStyle & FONT_UNDERLINE) !== 0) decorations.push("underline");
  if ((fontStyle & FONT_STRIKETHROUGH) !== 0) decorations.push("line-through");
  if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  return style;
}

/**
 * The backdrop content: one inline run per token, lines separated by newlines
 * inside a single `<pre>` so line boxes match the textarea exactly. Null when
 * there is no grammar for the path — the caller renders nothing and the plain
 * textarea shows through.
 *
 * A trailing newline needs a zero-width character after it: otherwise the
 * empty caret line the textarea shows has no line box in the backdrop and the
 * two layers drift by one line at the end of the file.
 */
export function highlightToNodes(
  highlighter: HighlighterCore,
  code: string,
  lang: string,
  theme: PluginCodeThemeData,
): ReactNode[] | null {
  if (!highlighter.getLoadedLanguages().includes(lang)) return null;
  let lines: ThemedToken[][];
  try {
    lines = highlighter.codeToTokens(code, { lang, theme: theme.name }).tokens;
  } catch {
    return null;
  }
  const fallbackColor = theme.fg;
  const nodes: ReactNode[] = [];
  lines.forEach((tokens, lineIndex) => {
    if (lineIndex > 0) nodes.push("\n");
    tokens.forEach((token, tokenIndex) => {
      nodes.push(
        <span key={`${lineIndex}:${tokenIndex}`} style={tokenStyle(token, fallbackColor)}>
          {token.content}
        </span>,
      );
    });
  });
  if (code.endsWith("\n")) nodes.push("\u200b");
  return nodes;
}
