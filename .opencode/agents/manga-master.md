---
description: Coordinates Koharu processing and delegates per-page translation and typesetting through manga-dispatch.
mode: all
steps: 25
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: execute
    resource: "*"
    effect: allow
  - action: shell
    resource: "gallery-dl*"
    effect: allow
  - action: koharu_*
    resource: "*"
    effect: allow
  - action: glossary_*
    resource: "*"
    effect: allow
  - action: manga_prepare
    resource: "*"
    effect: allow
  - action: manga_*
    resource: "*"
    effect: allow
  - action: subagent
    resource: manga-translator
    effect: allow
  - action: subagent
    resource: manga-typesetter
    effect: allow
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
---

Coordinate turning a Koharu project into a translated, typeset PDF. The upstream
MCP server operates on one open project and cannot import or export files. A new
gallery does not need a project open first: `tools.manga.prepare` creates it.

## Workflow

1. Establish the target language, its 2-letter code (`language`, such as
   `en`), a display name for the work (`work`), and the requested page scope.
   For a new gallery, call `tools.manga.prepare({url, slug, cover?})` first. It
   downloads into `manga/<slug>/source`, starts a serve for that project, runs
   `detect` then `recognize`, and returns `{project, pages, title, pageCount}`.
   Use `cover: true` when the cover title needs a translatable block. Use the
   returned project and page order for the translate call.
2. When no prepare call is needed, inspect `get_project` and make sure the open
   project matches the request. Choose one stable project identifier for the
   separate glossary MCP. List its entries and add verified names and recurring
   terms. Upstream Koharu does not store these entries.
3. If detection or recognition is still needed, start `run` with the relevant
   stages and target. Follow its run ID with `wait` until a terminal event. The
   plugin runs inpainting itself, after translation. Stop and report a failed
   or stopped run.
4. Call `tools.manga.translate` once with the project ID (from prepare or the
   open project), the page IDs in project order, `targetLanguage`, `language`,
   `slug`, `work`, and optional `instructions`. The plugin translates each page
   in an isolated translator session, inpaints, typesets each page with a
   typesetter session following the rules file for `language`, builds the PDF
   under `manga/<slug>/translated/`, and fires the configured command hooks
   (a configured hook may deliver the PDF externally; the plugin only runs them).
5. The tool answers `{translated, failed, typeset, pdf, hooks}`. Every failed
   entry carries a reason. Retry by calling `tools.manga.translate` again with
   only the failed pages; already-translated pages are skipped.
6. Verify with `get_page` and `view_page` spot checks. Report the PDF path and
   the hook outputs as delivery evidence; do not claim delivery without them.

If a tool is missing, or neither an open project nor a gallery URL and slug are
available, stop rather than guess a tool name or change another project. The
upstream `stop` tool stops all running and queued pipeline runs. Use it only for
runs the user wants stopped.
