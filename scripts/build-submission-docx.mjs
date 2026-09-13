#!/usr/bin/env node
/**
 * Build the submission `.docx` from `docs/GOOGLE_DOC.md`.
 *
 * The challenge asks for a **public Google Doc**. Google Docs imports `.docx`
 * directly, images included, so this is the one-step path: upload the result,
 * open it with Google Docs, share it. The markdown stays canonical; this script
 * only renders it for that upload.
 *
 * Requires `pandoc` on `PATH` (https://pandoc.org/installing.html). Nothing in
 * `npm test` or the app depends on it, and no credential is read.
 *
 *   npm run build:docx
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "docs", "GOOGLE_DOC.md");
const output = join(root, "docs", "T3N-Employee-Onboarding-Submission.docx");
const staging = join(root, ".submission-docx-source.md");

const markdown = readFileSync(source, "utf8");

// Drop the "how to use this file" preamble. It is guidance for whoever pastes
// the markdown, not content for the Doc, which starts at the title.
const titleAt = markdown.indexOf("\n## Employee onboarding");
if (titleAt === -1) {
  throw new Error(`could not find the Doc title heading in ${source}`);
}
let body = markdown.slice(titleAt + 1);

// Promote the title to a top-level heading so it does not sit beside the
// numbered sections.
body = body.replace(/^## /, "# ");

// Markdown cannot carry binaries, so the source marks where each screenshot
// belongs. Turn every marker into an image reference with an absolute path, so
// pandoc embeds the bytes rather than writing a link that would rot.
const missing = [];
body = body.replace(/^INSERT IMAGE: `([^`]+)`\s*$/gm, (_line, relative) => {
  const absolute = join(root, relative);
  if (!existsSync(absolute)) missing.push(relative);
  return `![](${absolute})`;
});
if (missing.length > 0) {
  throw new Error(`screenshot(s) not found: ${missing.join(", ")}`);
}

writeFileSync(staging, body, "utf8");

const pandoc = spawnSync("pandoc", [staging, "-f", "gfm", "-o", output], {
  cwd: root,
  stdio: "inherit",
});
rmSync(staging, { force: true });

if (pandoc.error !== undefined) {
  console.error(
    "pandoc is required to build the Docx. Install it from https://pandoc.org/installing.html",
  );
  process.exit(1);
}
if (pandoc.status !== 0) {
  process.exit(pandoc.status ?? 1);
}

console.log(`wrote ${output}`);
