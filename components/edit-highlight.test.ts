import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import {
  getEditHighlighter,
  highlightToNodes,
  isHighlightableSize,
  shikiLangForPath,
} from "./edit-highlight";

const THEME = {
  name: "test-theme",
  type: "dark",
  fg: "#ffffff",
  bg: "#000000",
  colors: {},
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#888888", fontStyle: "italic" },
    },
    {
      scope: "keyword",
      settings: { foreground: "#ff0000", fontStyle: "bold" },
    },
  ],
} as unknown as PluginCodeThemeData;

describe("shikiLangForPath", () => {
  it("maps common extensions to shiki language ids", () => {
    expect(shikiLangForPath("src/app.tsx")).toBe("tsx");
    expect(shikiLangForPath("src/app.ts")).toBe("typescript");
    expect(shikiLangForPath("x.JS")).toBe("javascript");
    expect(shikiLangForPath("run.sh")).toBe("shellscript");
    expect(shikiLangForPath("run.zsh")).toBe("shellscript");
    expect(shikiLangForPath("data.yml")).toBe("yaml");
    expect(shikiLangForPath("doc.md")).toBe("markdown");
    expect(shikiLangForPath("a/b/Dockerfile")).toBe("dockerfile");
    expect(shikiLangForPath("a/b/Makefile")).toBe("make");
  });

  it("returns null when there is no grammar", () => {
    expect(shikiLangForPath("notes.txt")).toBeNull();
    expect(shikiLangForPath("Makefile.am")).toBeNull();
    expect(shikiLangForPath("no-extension")).toBeNull();
  });
});

describe("isHighlightableSize", () => {
  it("accepts ordinary files", () => {
    expect(isHighlightableSize("const x = 1;\n".repeat(100))).toBe(true);
    expect(isHighlightableSize("")).toBe(true);
  });

  it("rejects huge files", () => {
    expect(isHighlightableSize("x".repeat(200_001))).toBe(false);
    expect(isHighlightableSize("x\n".repeat(5_001))).toBe(false);
  });
});

describe("edit highlighter", () => {
  it("builds from BB's theme object and loads the mapped grammars", () => {
    const highlighter = getEditHighlighter(THEME);
    expect(highlighter).not.toBeNull();
    expect(highlighter!.getLoadedLanguages()).toContain("typescript");
    expect(highlighter!.getLoadedLanguages()).toContain("tsx");
    // Same theme document reuses the singleton.
    expect(getEditHighlighter(THEME)).toBe(highlighter);
  });

  it("returns null without a theme", () => {
    expect(getEditHighlighter(null)).toBeNull();
  });

  it("tokenizes to colored spans", () => {
    const highlighter = getEditHighlighter(THEME)!;
    const nodes = highlightToNodes(
      highlighter,
      "const x = 1; // hi",
      "typescript",
      THEME,
    );
    expect(nodes).not.toBeNull();
    const spans = nodes!.filter(isValidElement);
    expect(spans.length).toBeGreaterThan(0);
    // The comment picks up the theme's comment color.
    const comment = spans.find(
      (span) =>
        (span.props as { style?: { color?: string } }).style?.color ===
        "#888888",
    );
    expect(comment).toBeDefined();
  });

  it("keeps the trailing caret line with a zero-width space", () => {
    const highlighter = getEditHighlighter(THEME)!;
    const nodes = highlightToNodes(highlighter, "a\n", "plaintext", THEME);
    // Plaintext is not loaded, so this falls back to null…
    expect(nodes).toBeNull();
    const typed = highlightToNodes(highlighter, "a\n", "typescript", THEME)!;
    expect(typed[typed.length - 1]).toBe("\u200b");
  });

  it("returns null for unloaded languages", () => {
    const highlighter = getEditHighlighter(THEME)!;
    expect(highlightToNodes(highlighter, "x", "cobol", THEME)).toBeNull();
  });
});
