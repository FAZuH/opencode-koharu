# manga-dispatch

Turns the pages of a Koharu project into a translated, typeset PDF, using one
isolated session per page. The project is either open at `options.koharuUrl` or
created by `manga_prepare`. Each session is bound to one page or project, so
prompts carry short labels instead of UUIDs and the session-bound tools
`manga_typeset`, `manga_view`, `manga_submit`, and `manga_glossary` take no page
or project argument. `manga_audit`, `manga_prepare`, and `manga_prune` do take
arguments.

## Tools

- `tools.manga.translate` (Code Mode): `{project, pages, targetLanguage,
  language?, slug?, work?, instructions?, koharuUrl?, llmTypeset?, pdfPages?,
  retypeset?}`. Runs the whole pipeline: translator sessions, inpaint,
  typesetting (LLM sessions or the `defaultTypesetting` mapping), PDF build,
  command hooks. Answers `{translated, failed, typeset, pdf, hooks}`. `language`
  is a 2-letter code; `slug` names the folder under `manga/`; `work` names the
  PDF file. `koharuUrl` targets another serve instance (one project per
  process); `llmTypeset` overrides the option per call; `pdfPages: "project"`
  (default) rebuilds the whole book while `"call"` builds only this call's
  pages; `retypeset: true` ignores the completion markers. Translation feeds a
  per-page queue that the typeset pool drains, so the two pools run at once and
  a slow page does not hold the book.
- `manga_submit` (translator sessions): translations in source order, either
  `["Alright~", "Mm♡", ...]` or `{"n": 3, "text": "..."}` objects. Positions map
  to the numbered lines in the prompt.
- `manga_glossary` (translator sessions, also `tools.manga.glossary`):
  `{source, translation, kind, note}`. The plugin injects the project.
- `manga_typeset` (typesetter sessions): `{ops}`, with `{"layer": "b3"}` short
  labels resolved against the session's layer set. Lettering ops only:
  `set_text`, `set_rich_text`, `update_layer` limited to a translation patch, and
  optical `transform_layer` on this session's blocks. Send all ops in one call.
- `manga_view` (typesetter sessions, also `tools.manga.view`): session-scoped
  render check with only an optional `region`. Two views per page is the limit;
  further calls return the cached render.
- `manga_prepare` (also `tools.manga.prepare`): `{url, slug, cover?}`. Downloads
  the gallery into `manga/<slug>/source`, starts a serve for its project, runs
  `detect` then `recognize`, and returns `{project, pages, title, pageCount}`.
  `cover: true` adds a translatable cover title block.
- `manga_audit` (also `tools.manga.audit`): optional `{project, pdf, slug, work}`.
  Read-only check for empty translations, CJK left in translations, duplicate
  frames, and PDF page-count mismatch.
- `manga_prune` (also `tools.manga.prune`): `{days?, dryRun?, ids?}`. Deletes old
  `manga/*` sessions, default 30 days.

## Agents

- `manga-translator`: deny all, allows `manga_submit` and `manga_glossary`.
- `manga-typesetter`: deny all, allows `manga_typeset` and `manga_view`.
- `manga-master`: calls `tools.manga.prepare` for a new gallery and
  `tools.manga.translate` for the pipeline; its model comes from the OpenCode
  configuration, not the agent definition. Its shell access is limited to the
  `gallery-dl` binary.

## Options

```json
{
  "koharuUrl": "http://127.0.0.1:7878/mcp",
  "priorTranslations": 10,
  "translateModel": "opencode-go/deepseek-v4.1-flash",
  "typesetModel": "opencode-go/deepseek-v4.1-flash",
  "cleanupSessions": false,
  "maxTranslations": 5,
  "maxTypesets": 5,
  "maxRetries": 10,
  "llmTypeset": true,
  "defaultTypesetting": { "en": { "direction": "horizontal", "frame": { "box": { "fit": "best" } } } },
  "pageMinutes": 8,
  "contactSheet": false,
  "hooks": [
    { "event": "pdf.built", "command": ["flux-cli", "send", "--device", "YOUR_DEVICE", "{{pdf}}"] }
  ]
}
```

`translateModel` and `typesetModel` are the per-page session models.
`maxTranslations` and `maxTypesets` bound the two pools; a translate worker
pushes its page to the typeset queue as soon as its edit succeeds, and the PDF
waits for the queue to drain. `maxRetries` is the per-page retry count, used
exactly as configured: 0 means one attempt, and there is no cap.
`cleanupSessions: false` (default) keeps the translate and typeset sessions in
the session list for inspection; `manga_prune` removes old `manga/*` sessions in
bulk, with `days`, `dryRun`, and explicit `ids`.

`llmTypeset: true` (default) gives each page to a typesetter session with the
`rules/RULES_<LANGUAGE>.md` content injected into its prompt. Before the session,
the plugin applies the base style in one atomic edit: horizontal direction,
centered align, language `en`, best fit, and centring in the balloon. The session
only adjusts size, wording, and optical placement. One batched `manga_typeset`
call is expected, followed by at most two `manga_view` renders; a follow-up
reminder asks for a single call and one view when the session keeps calling. The
time budget is `min(2 × pageMinutes, pageMinutes + blocks / 4)` per page (default
base 8), and a wrap-up reminder goes into that session at 1× and 2× the budget;
it never interrupts. `contactSheet: true` adds a labeled crop sheet to the
prompt.

`llmTypeset: false` skips the sessions and applies `defaultTypesetting`, a map
from language slug to a partial Koharu translation object with `direction`,
`style` (`chars` fields, `align`, `line_height`), `frame.box.fit`/`anchor`, and
`language`, using one atomic edit per page. `frame` applies only to blocks that
already have a box frame.

Each typeset page leaves a marker in plugin storage (`typeset/<project>`) with
a config fingerprint. A later call skips marked pages, inpaint included, until
`retypeset` is set or the page is translated again. `translated` entries for
skipped pages carry `skipped: true`.

Inpaint runs once per page for the life of the project (`painted/<project>` in
storage). `retypeset` re-runs the typesetter on the already-cleaned page; it
never re-inpaints. Re-inpainting a cleaned page feeds the mask back through the
model and can erase the art.

## Command hooks

`hooks` is an array of `{event, command}`. `command` is an argv array: one
argument per entry, `{{key}}` substitution per argument, no shell. A failing
hook is reported in the tool result and never fails the pipeline. Each hook
process gets `MANGA_EVENT`, `MANGA_SLUG`, `MANGA_WORK`, `MANGA_LANGUAGE`, and
`MANGA_HOOK_JSON` (all variables as JSON).

Events: `page.translated` (page, segments, source_text, translations,
translation_text, glossary, glossary_text, glossary_count), `page.failed`
(page, reason), `page.typeset` (page, calls), `pdf.built` (pdf, file, pages,
size, pdf_info), `pipeline.completed` (translated, typeset, failed). Every
event also carries `event`, `slug`, `work`, `language`, `time`, `timestamp`.

## Typesetting rules

`rules/RULES_<LANGUAGE>.md`, matched by the `language` input's 2-letter code
uppercased, is injected at the head of each typesetter prompt. No match injects
nothing. The translator gets a short shared SFX rule: translate SFX into
English, never romanize, keep hearts. `rules/RULES_EN.md` assumes the base style
is already applied and covers size, wording, optical nudges, and SFX contrast.

## PDF

Renders land in `manga/<slug>/translated/pages/`, per-page PDFs in
`translated/parts/`, and the united file `translated/<work> (translated).pdf`
at a uniform modal width, 150 dpi. `pdfPages: "project"` (default) renders every
page of the open project in project order, so a repair call for two pages
rebuilds the whole book. Run `manga_audit` after the build to check the PDF
page count against the project.

## Run journal

Each call writes `manga/<slug>/runs/<start ISO>.jsonl` (one line per page
attempt, stage, reminder, PDF) and `<start>.result.json` (the accumulated
result). A journal write error is reported as `journal` in the tool result and
never fails the run.
