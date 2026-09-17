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

import langAstro from "@shikijs/langs/astro";
import langC from "@shikijs/langs/c";
import langCpp from "@shikijs/langs/cpp";
import langCsharp from "@shikijs/langs/csharp";
import langCss from "@shikijs/langs/css";
import langDart from "@shikijs/langs/dart";
import langDockerfile from "@shikijs/langs/dockerfile";
import langElixir from "@shikijs/langs/elixir";
import langGo from "@shikijs/langs/go";
import langHtml from "@shikijs/langs/html";
import langJava from "@shikijs/langs/java";
import langJavascript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langJsonc from "@shikijs/langs/jsonc";
import langJsx from "@shikijs/langs/jsx";
import langKotlin from "@shikijs/langs/kotlin";
import langLess from "@shikijs/langs/less";
import langLua from "@shikijs/langs/lua";
import langMake from "@shikijs/langs/make";
import langMarkdown from "@shikijs/langs/markdown";
import langMdx from "@shikijs/langs/mdx";
import langPerl from "@shikijs/langs/perl";
import langPhp from "@shikijs/langs/php";
import langPython from "@shikijs/langs/python";
import langR from "@shikijs/langs/r";
import langRuby from "@shikijs/langs/ruby";
import langRust from "@shikijs/langs/rust";
import langScss from "@shikijs/langs/scss";
import langShellscript from "@shikijs/langs/shellscript";
import langSql from "@shikijs/langs/sql";
import langSvelte from "@shikijs/langs/svelte";
import langSwift from "@shikijs/langs/swift";
import langToml from "@shikijs/langs/toml";
import langTsx from "@shikijs/langs/tsx";
import langTypescript from "@shikijs/langs/typescript";
import langVue from "@shikijs/langs/vue";
import langXml from "@shikijs/langs/xml";
import langYaml from "@shikijs/langs/yaml";

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

/** Extension (lowercase, no dot) to shiki language id. */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  astro: "astro",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  php: "php",
  pl: "perl",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
};

const LANG_BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "make",
};

/** Null when the path has no grammar: the editor stays plain text. */
export function shikiLangForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = LANG_BY_FILENAME[name];
  if (byName !== undefined) return byName;
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
    langs: [
      langAstro,
      langC,
      langCpp,
      langCsharp,
      langCss,
      langDart,
      langDockerfile,
      langElixir,
      langGo,
      langHtml,
      langJava,
      langJavascript,
      langJson,
      langJsonc,
      langJsx,
      langKotlin,
      langLess,
      langLua,
      langMake,
      langMarkdown,
      langMdx,
      langPerl,
      langPhp,
      langPython,
      langR,
      langRuby,
      langRust,
      langScss,
      langShellscript,
      langSql,
      langSvelte,
      langSwift,
      langToml,
      langTsx,
      langTypescript,
      langVue,
      langXml,
      langYaml,
    ],
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
