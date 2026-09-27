/**
 * Theme isolation.
 *
 * The dashboard ships three aesthetic profiles off one document, so any colour
 * or font written as a literal instead of a token leaks: the retro profile
 * inherited the terminal's black nav bar and its emissive green title glow,
 * and every panel heading was authored with only a phosphor and a claude
 * variant, which left the retro profile rendering them blank.
 *
 * These cases read the shipped stylesheet and pin the three properties that
 * leak, plus the structural rule that makes retro's headings render at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const html = readFileSync(
  path.join(process.cwd(), "frontend", "nanites-dashboard.html"),
  "utf8",
);
const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

/** Body-level rules: everything outside a theme block or a media query. A
 *  theme block is multi-line, so its contents are dropped by brace depth, not
 *  by matching the line that happens to open it. */
const unscoped = (() => {
  const out: string[] = [];
  let depth = 0;
  for (const line of style.split("\n")) {
    if (/html\[data-theme=/.test(line) || /^\s*@media/.test(line)) {
      depth = 1;
      continue;
    }
    if (depth > 0) {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
})();

describe("theme isolation", () => {
  it("gives every aesthetic profile the same surface token contract", () => {
    for (const token of ["--surface", "--scrim", "--header-wash", "--accent-rgb"]) {
      const blocks = style.match(new RegExp(token + ":", "g")) ?? [];
      // Once per theme block: retro day, retro night, phosphor, claude. The
      // --accent-rgb default lives on the bare `html` rule, so it appears once
      // fewer time than the others.
      const expected = token === "--accent-rgb" ? 3 : 4;
      expect(blocks.length, `${token} declared in ${blocks.length} places`).toBe(expected);
    }
  });

  it("keeps the dark-terminal surfaces out of the unscoped rules", () => {
    // These are the exact literals that made the retro profile render a black
    // nav bar and a black terminal. They now live only in the phosphor block.
    for (const literal of [/rgba\(0,\s*0,\s*0,\s*0?\.5\)/, /#010401/]) {
      const offenders = unscoped
        .split("\n")
        .filter((l) => literal.test(l) && !/var\(--/.test(l));
      expect(offenders, `unscoped: ${offenders.join(" | ")}`).toEqual([]);
    }
  });

  it("derives every glow from the per-theme accent instead of a fixed green", () => {
    // A literal green in a text-shadow is a phosphor glow that survives a
    // theme switch. rgba(var(--accent-rgb), …) is repainted with the profile.
    const fixedGlow = unscoped
      .split("\n")
      .filter((l) => /text-shadow/.test(l) && /57\s*,\s*255\s*,\s*20/.test(l));
    expect(fixedGlow).toEqual([]);
  });

  it("paints every visible heading in retro", () => {
    // Each panel title is a <span class="…-only"> group. Retro was authored
    // with only the phosphor and claude twins, so every one rendered empty.
    const titles = [...html.matchAll(/<p class="panel-title">([\s\S]*?)<\/p>/g)].map(
      (m) => m[1],
    );
    expect(titles.length).toBeGreaterThan(5);
    for (const t of titles) {
      // The heading itself, not merely a retro tag elsewhere in the line: a
      // retro-only <span class="panel-tag"> would otherwise satisfy the check
      // while the title text itself stayed blank.
      expect(t, `no retro heading in: ${t.slice(0, 80)}`).toMatch(
        /<span class="retro-only">[^<]+<\/span>\s*<span class="claude-only">/,
      );
    }
  });

  it("sizes the retro headline to the style guide and drops the glow", () => {
    expect(style).toMatch(
      /html\[data-theme="retro"\][^}]*h1\.title[^}]*font-size:20px/,
    );
    expect(style).toMatch(/html\[data-theme="retro"\][^}]*text-shadow:none/);
  });

  it("holds every profile's logo in one identically-sized holder", () => {
    const marks = [...html.matchAll(/<div class="brand-mark[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(marks).toHaveLength(3);
    for (const theme of ["phos", "retro", "claude"]) {
      expect(marks.filter((m) => m.includes(`${theme}-only`))).toHaveLength(1);
    }
    // One holder rule, no per-theme override, so the box cannot drift.
    expect(style).toMatch(/\.brand-mark\{[^}]*width:56px;[^}]*height:56px/);
    expect(style).not.toMatch(/html\[data-theme="[a-z]+"\] \.brand-mark\{[^}]*width/);
  });

  it("keeps the legacy fixed-position mascot lockup out of the header", () => {
    // It was position:fixed at the viewport corner, which is how the logo came
    // to render twice in the claude profile, both copies overlapping.
    expect(html).not.toMatch(/mascot-lockup/);
    expect(html).not.toMatch(/mascot-platform/);
  });

  it("serialises profile switches so a double click fires one request", () => {
    expect(html).toMatch(/grid\.dataset\.switching/);
  });
});
