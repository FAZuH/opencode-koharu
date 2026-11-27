import { Plugin } from "@opencode/plugin"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { existsSync, readFileSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { baseStyleOps, blocks, cjk, coverBlockOps, coverBox, duplicateFrames, jobQueue, jpegSize, layerIds, modalWidth, needsFollowup, ocrWords, pageBudget, parseSubmitTranslations, pdfInfo, pool, prompt, resolveLabels, rulesFile, scopeEditOps, substitute, typesetPrompt, typesettingDefaults, typesettingOps, untranslated, validate } from "./page"
import type { Block, Segment, Typesetting } from "./page"

const schemaString = { type: "string", minLength: 1 }
const submitItem = {
  anyOf: [
    schemaString,
    {
      type: "object",
      properties: { n: { type: "integer", minimum: 1 }, text: schemaString },
      required: ["n", "text"],
      additionalProperties: false,
    },
  ],
}
const submitSchema = {
  oneOf: [
    { type: "array", items: submitItem },
    { type: "string" },
    {
      type: "object",
      properties: { translations: { anyOf: [{ type: "array", items: submitItem }, { type: "string" }] } },
      required: ["translations"],
      additionalProperties: false,
    },
  ],
}
const rulesDir = join(import.meta.dir, "rules")

async function upstream(url: string) {
  const client = new Client({ name: "manga-dispatch", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args }, undefined, { signal })
  if (result.isError) throw new Error(result.content?.map((part: any) => part.text).join("\n") || `${name} failed`)
  return result
}

function json(result: any) {
  const part = result.content?.find((item: any) => item.type === "text")
  if (!part) throw new Error("MCP response has no text")
  return JSON.parse(part.text)
}

async function glossaryClient(directory: string) {
  const client = new Client({ name: "manga-dispatch", version: "1.0.0" })
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [join(directory, "tools/glossary-mcp/src/server.ts")],
    cwd: directory,
  }))
  return client
}

async function glossary(project: string, directory: string, signal?: AbortSignal) {
  const client = await glossaryClient(directory)
  try {
    return json(await call(client, "list", { project }, signal)).entries
  } finally {
    await client.close()
  }
}

async function glossaryAdd(project: string, directory: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const client = await glossaryClient(directory)
  try {
    const entry = json(await call(client, "add", { project, ...input }, signal)).entry
    return { source: entry.source, translation: entry.translation, kind: entry.kind, note: entry.note ?? null }
  } finally {
    await client.close()
  }
}

/** Runs one pipeline stage on pages and waits for its terminal event. */
async function runStage(client: Client, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number) {
  const started = json(await call(client, "run", args, signal))
  const id = typeof started === "number" ? started : started?.run ?? started?.id
  if (typeof id !== "number") throw new Error("run did not answer a run id")
  const t0 = Date.now()
  for (;;) {
    const events = json(await call(client, "wait", { run: id }, signal))
    const last = Array.isArray(events) ? events.at(-1) : undefined
    if (last?.outcome) return last
    if (Date.now() - t0 > timeoutMs) throw new Error("run timed out")
  }
}

/** One `command` from the plugin options, run with the event's variables. */
type HookOutcome = { event: string; command: string[]; ok: boolean; exit: number | null; output: string }

function hooks(config: unknown) {
  const list = (Array.isArray(config) ? config : []).filter((hook: any) =>
    typeof hook?.event === "string" && Array.isArray(hook?.command) && hook.command.every((part: any) => typeof part === "string") && hook.command.length > 0)
  return async (event: string, vars: Record<string, unknown>): Promise<HookOutcome[]> => {
    const outcomes: HookOutcome[] = []
    for (const hook of list) {
      if (hook.event !== event) continue
      const command = hook.command.map((part: string) => substitute(part, vars))
      const env = {
        ...process.env,
        MANGA_EVENT: event,
        MANGA_HOOK_JSON: JSON.stringify(vars),
        ...(vars.slug !== undefined ? { MANGA_SLUG: String(vars.slug) } : {}),
        ...(vars.work !== undefined ? { MANGA_WORK: String(vars.work) } : {}),
        ...(vars.language !== undefined ? { MANGA_LANGUAGE: String(vars.language) } : {}),
      }
      try {
        const proc = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" })
        const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        outcomes.push({ event, command, ok: exit === 0, exit, output: `${stdout}${stderr}`.trim().slice(0, 2000) })
      } catch (error) {
        outcomes.push({ event, command, ok: false, exit: null, output: String(error).slice(0, 500) })
      }
    }
    return outcomes
  }
}

/** Runs a command, throwing when it fails; captures stdout when asked. */
async function run(command: string[], capture = false): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (exit !== 0) throw new Error(`${command[0]} failed (${exit}): ${`${stdout}${stderr}`.trim().slice(0, 500)}`)
  return capture ? stdout.trim() : ""
}

/** Wrap-up notice for a page that runs past its time budget. */
function budgetReminder(minutes: number): string {
  const shown = Math.round(minutes * 10) / 10
  return `Time budget: ${shown} minutes used on this page. Finish now: send the remaining ops in one manga_typeset call, then check once with manga_view. No confirmation call is needed. A page past the second reminder is retried in a new session.`
}

/** One wrap-up turn after the first edit, so the batching rule is explicit. */
const followupPrompt = "Finish the remaining ops in one manga_typeset call, then check the render once with manga_view. No empty confirmation call is needed."

/** One labeled crop per block, tiled into a single JPEG; undefined on failure. */
async function contactSheetFile(render: string, dir: string, items: Block[]): Promise<string | undefined> {
  const framed = items.filter((item) => item.frame !== null)
  if (!framed.length) return undefined
  try {
    const crops: string[] = []
    for (const [index, item] of framed.entries()) {
      const frame = item.frame!
      const x = Math.max(0, Math.round(frame.x - 8))
      const y = Math.max(0, Math.round(frame.y - 8))
      const width = Math.max(1, Math.round(frame.width + 16))
      const height = Math.max(1, Math.round(frame.height + 16))
      const file = join(dir, `crop-${index}.jpg`)
      await run(["magick", render, "-crop", `${width}x${height}+${x}+${y}`, "+repage", "-resize", "480x480>", file])
      crops.push(file)
    }
    const sheet = join(dir, "sheet.jpg")
    const command = ["magick", "montage"]
    framed.forEach((item, index) => command.push("-label", item.label, crops[index]))
    command.push("-tile", "4x", "-geometry", "480x480+6+6", "-background", "white", "-pointsize", "20", sheet)
    await run(command)
    return sheet
  } catch {
    return undefined
  }
}

function modelRef(configured: unknown) {
  if (typeof configured === "string" && configured.includes("/")) {
    const i = configured.indexOf("/")
    return { providerID: configured.slice(0, i), id: configured.slice(i + 1) }
  }
  if (configured && typeof configured === "object") {
    const m = configured as Record<string, unknown>
    if (typeof m.providerID === "string" && typeof (m.id ?? m.modelID) === "string") return { providerID: m.providerID, id: (m.id ?? m.modelID) as string }
  }
  return undefined
}

function sanitized(name: string): string {
  return name.replace(/[/\\]/g, "-").replace(/[\x00-\x1f]/g, "").trim()
}

/** A concurrency limit, at least 1, default 5. */
function concurrency(configured: unknown): number {
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 1 ? configured : 5
}

/** Retries per page, used exactly as configured: 0 is one attempt, and there is no cap. */
function retries(configured: unknown): number {
  if (configured === undefined) return 10
  if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 0) throw new Error("maxRetries must be a non-negative integer")
  return configured
}

export default Plugin.define({
  id: "manga-dispatch",
  async setup(ctx) {
    const url = typeof ctx.options?.koharuUrl === "string" ? ctx.options.koharuUrl : "http://127.0.0.1:7878/mcp"
    const count = typeof ctx.options?.priorTranslations === "number" && Number.isInteger(ctx.options.priorTranslations) && ctx.options.priorTranslations >= 0 ? ctx.options.priorTranslations : 10
    const translatorModel = modelRef(ctx.options?.translateModel)
    const typesetterModel = modelRef(ctx.options?.typesetModel) ?? translatorModel
    // Sessions a page used stay in the session list for inspection when this is off.
    const cleanupSessions = ctx.options?.cleanupSessions === true
    const maxTranslations = concurrency(ctx.options?.maxTranslations)
    const maxTypesets = concurrency(ctx.options?.maxTypesets)
    const maxRetries = retries(ctx.options?.maxRetries)
    // With this off, a page gets the default typesetting for its language
    // (the `defaultTypesetting` mapping) instead of a typesetter session.
    const llmTypeset = ctx.options?.llmTypeset !== false
    // Minutes of typesetter work before a wrap-up reminder, which never kills
    // the session; a second reminder follows at twice the budget.
    const pageMinutes = typeof ctx.options?.pageMinutes === "number" && Number.isFinite(ctx.options.pageMinutes) && ctx.options.pageMinutes > 0 ? ctx.options.pageMinutes : 8
    // One labeled crop per block, tiled into a single image for the typesetter.
    const contactSheet = ctx.options?.contactSheet === true
    const defaultTypesetting = typesettingDefaults(ctx.options?.defaultTypesetting)
    const fire = hooks(ctx.options?.hooks)
    const pending = new Map<string, { project: string; segments: Segment[]; translations?: Segment[] }>()
    const typesetTask = new Map<string, {
      client: Client
      signal: AbortSignal
      page: string
      layers: Set<string>
      translated: Set<string>
      labelOf: Map<string, string>
      byLabel: Map<string, string>
      calls: number
      lastOps: number
      render: string
      views: number
      dirty: boolean
      followed: boolean
    }>()
    const active = new Set<string>()
    const controller = new AbortController()
    const children = new Set<string>()

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "manga", description: "Translate and typeset Koharu pages into a PDF" })
      editor.add({
        name: "submit",
        description: "Submit translations in source order: an array, {n,text} objects, or a JSON string wrapping either.",
        options: { namespace: "manga" },
        input: submitSchema,
        execute: async (input: any, context: any) => {
          const task = pending.get(context.sessionID)
          if (!task) throw new Error("No translation is assigned to this session")
          if (task.translations) throw new Error("Translation already submitted")
          const list = parseSubmitTranslations(input)
          const translations: Segment[] = list.map((item, index) => {
            const n = typeof item === "string" ? index + 1 : item?.n
            const value = typeof item === "string" ? item : item?.text
            const source = task.segments[n - 1]
            if (!source) throw new Error(`No source block at position ${n}`)
            if (typeof value !== "string") throw new Error(`Translation ${n} needs text`)
            return { id: source.id, text: value }
          })
          validate(task.segments, translations)
          task.translations = translations
          return { content: JSON.stringify({ accepted: true }) }
        },
      })
      editor.add({
        name: "glossary",
        description: "Record a name, place or term for this project. Supply source, translation, kind and optional note.",
        options: { namespace: "manga" },
        input: {
          type: "object",
          properties: {
            source: schemaString,
            translation: schemaString,
            kind: { type: "string", enum: ["name", "place", "term"] },
            note: { type: "string" },
          },
          required: ["source", "translation", "kind"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const task = pending.get(context.sessionID)
          if (!task) throw new Error("No translation is assigned to this session")
          const entry = await glossaryAdd(task.project, ctx.location.directory, {
            source: input.source, translation: input.translation, kind: input.kind,
            ...(input.note !== undefined ? { note: input.note } : {}),
          }, context.signal)
          return { content: JSON.stringify({ entry }) }
        },
      })
      editor.add({
        name: "typeset",
        description: "Apply lettering ops to this session's page in one atomic edit. Allowed: set_text, set_rich_text, update_layer with a translation patch only, and transform_layer for optical nudges. Use short labels such as b3 as the layer. Rejects blank text, structural ops and page ops. One call with all ops is expected.",
        options: { namespace: "manga" },
        input: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              items: { type: "object" },
              description: "Lettering ops, for example {op:'set_text',layer:'b3',text:'SQUELCH'}.",
            },
          },
          required: ["ops"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const task = typesetTask.get(context.sessionID)
          if (!task) throw new Error("No page is assigned to this session")
          const ops = resolveLabels(input.ops, task.byLabel)
          const checked = scopeEditOps(ops, task.page, task.layers, task.labelOf, task.translated)
          task.calls++
          task.lastOps = checked.length
          if (checked.length) {
            await call(task.client, "edit", { label: `Typeset page ${task.page}`, ops: checked }, task.signal)
            task.dirty = true
          }
          return { content: JSON.stringify({ applied: checked.length }) }
        },
      })
      editor.add({
        name: "view",
        description: "Check the render of this session's page. Takes only an optional region {x,y,width,height}. Two views per page; further calls return the cached render.",
        options: { namespace: "manga" },
        input: {
          type: "object",
          properties: {
            region: {
              type: "object",
              properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } },
              required: ["x", "y", "width", "height"],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const task = typesetTask.get(context.sessionID)
          if (!task) throw new Error("No page is assigned to this session")
          const cached = task.views >= 2
          if (!cached && task.dirty) {
            const view = await call(task.client, "view_page", { page: task.page }, task.signal)
            const attachment = view.content?.find((part: any) => part.type === "image")
            if (!attachment?.data) throw new Error(`No render for page ${task.page}`)
            await writeFile(task.render, Buffer.from(attachment.data, "base64"))
            task.dirty = false
          }
          task.views++
          let file = task.render
          if (input.region) {
            const r = input.region
            file = join(dirname(task.render), `region-${task.views}.jpg`)
            await run(["magick", task.render, "-crop", `${r.width}x${r.height}+${r.x}+${r.y}`, "+repage", file])
          }
          const image = (await readFile(file)).toString("base64")
          return {
            content: [
              { type: "text", text: JSON.stringify({ cached, view: task.views }) },
              { type: "image", data: image, mimeType: "image/jpeg" },
            ],
          }
        },
      })
      editor.add({
        name: "prepare",
        description: "Download a gallery into manga/<slug>/source, start a Koharu serve for its project, then run detect and recognize. Optional cover:true adds a translatable title block without a mask. Returns project, pages, title and pageCount.",
        options: { namespace: "manga", codemode: true },
        input: {
          type: "object",
          properties: {
            url: { type: "string", pattern: "^https?://" },
            slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
            cover: { type: "boolean" },
          },
          required: ["url", "slug"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const directory = ctx.location.directory
          const source = join(directory, "manga", input.slug, "source")
          const project = join(directory, "manga", input.slug, "project.khr")
          await rm(source, { recursive: true, force: true })
          await mkdir(source, { recursive: true })
          const downloader = process.env.GALLERY_DL_BIN || Bun.which("gallery-dl")
          if (!downloader) throw new Error("gallery-dl not found on PATH; set GALLERY_DL_BIN")
          await run([downloader, "--write-info-json", "-D", source, input.url])
          const found: string[] = []
          const walk = async (dir: string) => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const path = join(dir, entry.name)
              if (entry.isDirectory()) await walk(path)
              else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) found.push(path)
            }
          }
          await walk(source)
          found.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }))
          if (!found.length) throw new Error("gallery-dl downloaded no page images")
          const images: string[] = []
          for (const [index, file] of found.entries()) {
            const target = join(source, `${String(index + 1).padStart(3, "0")}${file.slice(file.lastIndexOf(".")).toLowerCase()}`)
            if (file !== target) await rename(file, target)
            images.push(target)
          }
          let title = input.slug
          const metadata: string[] = []
          const meta = async (dir: string) => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const path = join(dir, entry.name)
              if (entry.isDirectory()) await meta(path)
              else if (entry.name.endsWith(".json")) metadata.push(path)
            }
          }
          await meta(source)
          for (const file of metadata) {
            try {
              const data = JSON.parse(await readFile(file, "utf8"))
              const value = data.title ?? data.gallery_title ?? data.name ?? data.work
              if (typeof value === "string" && value.trim()) { title = value.trim(); break }
            } catch {}
          }
          await run([join(directory, "bin", "serve.sh"), "--stop", "7878"])
          await run([join(directory, "bin", "serve.sh"), project, "7878", ...images])
          const client = await upstream(url)
          let cover: Record<string, unknown> | undefined
          try {
            const projectBody = json(await call(client, "get_project", {}, context.signal))
            const ids: string[] = projectBody.pages.map((page: any) => page.id)
            await runStage(client, { target: { pages: ids }, stages: ["detect"] }, context.signal, 30 * 60 * 1000)
            await runStage(client, { target: { pages: ids }, stages: ["recognize"] }, context.signal, 30 * 60 * 1000)
            if (input.cover === true && ids.length) {
              const tsv = await run(["tesseract", images[0], "stdout", "--psm", "11", "tsv"], true)
              const heightText = await run(["magick", "identify", "-format", "%h", images[0]], true)
              const height = Number(heightText)
              const foundTitle = coverBox(ocrWords(tsv, 10), Number.isFinite(height) ? height : undefined)
              const body = json(await call(client, "get_page", { page: ids[0] }, context.signal))
              const hasBlocks = blocks(body).length > 0
              let created = false
              if (foundTitle && !hasBlocks) {
                await call(client, "edit", { label: "Cover title block", ops: coverBlockOps(ids[0], foundTitle) }, context.signal)
                created = true
              }
              cover = { created, needsMask: true, text: foundTitle?.text ?? null, ...(hasBlocks ? { reason: "cover already has blocks" } : !foundTitle ? { reason: "no title above the OCR threshold" } : {}) }
            }
            return { content: JSON.stringify({ project: projectBody.id, pages: ids, title, pageCount: ids.length, ...(cover ? { cover } : {}) }) }
          } finally {
            await client.close()
          }
        },
      })
      editor.add({
        name: "audit",
        description: "Read-only audit of the open project: empty translations, CJK left in translations, duplicate frame bounds, and PDF page count mismatch.",
        options: { namespace: "manga", codemode: true },
        input: {
          type: "object",
          properties: {
            project: { type: "string" },
            pdf: { type: "string", description: "PDF path to check; defaults to translated/<work> (translated).pdf under manga/<slug>." },
            slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
            work: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const client = await upstream(url)
          try {
            const current = json(await call(client, "get_project", {}, context.signal))
            if (input.project !== undefined && input.project !== current.id) throw new Error("The open project does not match the requested project")
            const empty: { page: string; source: string }[] = []
            const cjkTexts: { page: string; translation: string }[] = []
            const duplicates: { page: string; frame: unknown; labels: string[] }[] = []
            for (const page of current.pages) {
              const body = json(await call(client, "get_page", { page: page.id }, context.signal))
              for (const item of untranslated(body)) empty.push({ page: page.id, source: item.text })
              for (const item of blocks(body)) if (cjk(item.text)) cjkTexts.push({ page: page.id, translation: item.text })
              for (const item of duplicateFrames(body)) duplicates.push({ page: page.id, frame: item.frame, labels: item.labels })
            }
            let pdf: Record<string, unknown> | undefined
            const pdfPath = typeof input.pdf === "string" ? input.pdf : input.slug && input.work
              ? join(ctx.location.directory, "manga", input.slug, "translated", `${sanitized(input.work)} (translated).pdf`)
              : undefined
            if (pdfPath && existsSync(pdfPath)) {
              const info = pdfInfo(await run(["pdfinfo", "-f", "1", "-l", String(current.pages.length), "-box", pdfPath], true))
              const size = (await stat(pdfPath)).size
              pdf = { path: pdfPath, size, ...info, mismatch: info.pages !== undefined && info.pages !== current.pages.length }
            }
            return { content: JSON.stringify({ project: current.id, pageCount: current.pages.length, empty, cjk: cjkTexts, duplicates, pdf }) }
          } finally {
            await client.close()
          }
        },
      })
      editor.add({
        name: "prune",
        description: "Delete old manga/* sessions. Supply days (default 30), optional dryRun and explicit ids. Only sessions whose title starts with manga/ are eligible.",
        options: { namespace: "manga", codemode: true },
        input: {
          type: "object",
          properties: {
            days: { type: "number", minimum: 0, description: "Delete sessions older than this many days." },
            dryRun: { type: "boolean" },
            ids: { type: "array", items: schemaString },
          },
          additionalProperties: false,
        },
        execute: async (input: any) => {
          if (typeof ctx.session.list !== "function" || typeof ctx.session.remove !== "function") throw new Error("This host cannot list and remove sessions")
          const days = typeof input.days === "number" ? input.days : 30
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
          const listed: any = await ctx.session.list()
          const nested = ["sessions", "data", "items"].map((key) => listed?.[key]).find(Array.isArray)
          const sessions = Array.isArray(listed) ? listed : nested ?? (listed && typeof listed === "object" ? Object.values(listed) : [])
          const explicit = Array.isArray(input.ids) ? new Set<string>(input.ids) : undefined
          const matched = sessions.filter((session: any) => {
            if (!session || typeof session !== "object") return false
            const id = session.id ?? session.sessionID
            if (typeof id !== "string") return false
            if (explicit && !explicit.has(id)) return false
            if (typeof session.title !== "string" || !session.title.startsWith("manga/")) return false
            const raw = session.time?.created ?? session.created ?? session.time?.updated ?? session.updated
            const created = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN
            return Number.isFinite(created) && created < cutoff
          })
          const ids = matched.map((session: any) => session.id ?? session.sessionID)
          if (input.dryRun !== true) {
            for (const id of ids) await ctx.session.remove({ sessionID: id }).catch(() => undefined)
          }
          return { content: JSON.stringify({ days, dryRun: input.dryRun === true, matched: ids, removed: input.dryRun === true ? [] : ids }) }
        },
      })
      editor.add({
        name: "translate",
        description: "Translate, typeset, and build the PDF for the requested pages in the open Koharu project, with isolated sessions per page.",
        options: { namespace: "manga", codemode: true },
        input: {
          type: "object",
          properties: {
            project: schemaString,
            pages: { type: "array", items: schemaString, minItems: 1 },
            targetLanguage: schemaString,
            language: { type: "string", pattern: "^[a-zA-Z]{2}$", description: "The target language's 2-letter code; selects the typesetting rules file." },
            slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "The work's folder name under manga/." },
            work: schemaString,
            instructions: { type: "string" },
            koharuUrl: { type: "string", pattern: "^https?://", description: "The Koharu MCP URL when the project is not on the configured one." },
            llmTypeset: { type: "boolean", description: "Overrides the llmTypeset option for this call." },
            pdfPages: { type: "string", enum: ["project", "call"], description: "Which pages the PDF holds: every page of the open project (default, so a repair of 2 pages rebuilds the whole book) or only this call's pages." },
            retypeset: { type: "boolean", description: "Typeset the given pages again even when an earlier call marked them done." },
          },
          required: ["project", "pages", "targetLanguage"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          if (active.has(input.project)) throw new Error("A translation is already active for this project")
          active.add(input.project)
          const signal = AbortSignal.any([context.signal, controller.signal])
          const language = typeof input.language === "string" ? input.language.toLowerCase() : undefined
          if (language !== undefined && !/^[a-z]{2}$/.test(language)) throw new Error("language must be a 2-letter code")
          const slug = typeof input.slug === "string" ? input.slug : input.project
          const work = typeof input.work === "string" ? input.work : slug
          const rulesPath = language !== undefined ? join(rulesDir, rulesFile(language)) : undefined
          const rules = rulesPath !== undefined && existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : ""
          const useLlmTypeset = input.llmTypeset !== undefined ? input.llmTypeset === true : llmTypeset
          const langCode = language ?? input.targetLanguage.toLowerCase().slice(0, 2)
          const pdfScope = input.pdfPages === "call" ? "call" : "project"
          const retypeset = input.retypeset === true
          const rulesHash = createHash("sha1").update(rules).digest("hex").slice(0, 12)
          const fingerprint = useLlmTypeset
            ? `llm:${typesetterModel ? `${typesetterModel.providerID}/${typesetterModel.id}` : "parent"};rules:${rulesHash}`
            : `default:${JSON.stringify(language !== undefined ? defaultTypesetting[language] ?? null : null)};rules:${rulesHash}`
          const runStamp = new Date().toISOString().replace(/[:.]/g, "-")
          const runDir = join(ctx.location.directory, "manga", slug, "runs")
          let journalError: string | undefined
          const journal = async (entry: Record<string, unknown>) => {
            try {
              await mkdir(runDir, { recursive: true })
              await appendFile(join(runDir, `${runStamp}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
            } catch (error) {
              journalError ??= String((error as any)?.message ?? error)
            }
          }
          const globals = { slug, work, language, time: "", timestamp: 0 }
          const hookOutcomes: HookOutcome[] = []
          const stamp = () => { globals.timestamp = Date.now(); globals.time = new Date(globals.timestamp).toISOString() }
          let client: Client | undefined
          const failed: { page: string; reason: string; attempts: number }[] = []
          const typeset: { page: string; calls: number; skipped?: boolean }[] = []
          let pdf: { path: string; pages: number; size: number; pageSize?: string } | undefined
          let translated: string[] = []
          const saveResult = async () => {
            try {
              await mkdir(runDir, { recursive: true })
              await writeFile(join(runDir, `${runStamp}.result.json`), JSON.stringify({ translated, failed, typeset, pdf }, null, 2))
            } catch (error) {
              journalError ??= String((error as any)?.message ?? error)
            }
          }
          try {
            client = await upstream(typeof input.koharuUrl === "string" ? input.koharuUrl : url)
            const current = json(await call(client, "get_project", {}, signal))
            if (current.id !== input.project) throw new Error("The open Koharu project does not match the requested project ID")
            const known = new Set(current.pages.map((page: any) => page.id))
            if (new Set(input.pages).size !== input.pages.length || input.pages.some((page: string) => !known.has(page))) throw new Error("Unknown or duplicate page")
            const priorKey = `prior/${input.project}`
            const previous: any[] = (await ctx.storage.get(priorKey) as any[]) ?? []
            const markerKey = `typeset/${input.project}`
            const markers: Record<string, { calls: number; at: string; config: string }> = (await ctx.storage.get(markerKey) as any) ?? {}
            // A page is inpainted once in its life: re-running it after a
            // retypeset would feed the already-cleaned page back to the model.
            const paintedKey = `painted/${input.project}`
            const painted: Record<string, true> = (await ctx.storage.get(paintedKey) as any) ?? {}
            const remember = async (page: string, calls: number) => {
              markers[page] = { calls, at: new Date().toISOString(), config: fingerprint }
              await ctx.storage.set(markerKey, markers)
            }
            const forget = async (page: string) => {
              if (!markers[page]) return
              delete markers[page]
              await ctx.storage.set(markerKey, markers)
            }
            const pageItems = new Map<string, Block[]>()
            const pageScopes = new Map<string, Set<string>>()
            const ready = jobQueue<{ page: string; items: Block[]; scopes: Set<string> }>()
            const translateWorkers = pool(maxTranslations, input.pages, async (page) => {
              const started = Date.now()
              let attempts = 0
              let failure: string | undefined
              // One attempt: translate the page's untranslated blocks with a
              // fresh session, then record what the page now holds. A page
              // whose earlier attempt already translated it skips the session.
              const attempt = async (n: number) => {
                const source = untranslated(json(await call(client, "get_page", { page }, signal)))
                if (source.length) {
                  const image = await call(client, "view_page", { page, original: true }, signal)
                  const attachment = image.content?.find((part: any) => part.type === "image")
                  if (!attachment?.data) throw new Error(`No source image for page ${page}`)
                  const entries = await glossary(input.project, ctx.location.directory, signal)
                  const dir = await mkdtemp(join(tmpdir(), "manga-dispatch-"))
                  const filename = join(dir, "page.jpg")
                  let child: any
                  try {
                    await writeFile(filename, Buffer.from(attachment.data, "base64"))
                    const parent = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
                    const model = translatorModel ?? parent?.model
                    child = await ctx.session.create({ agent: "manga-translator", title: `manga/${input.project}/page-${page}`, ...(model ? { model } : {}) })
                    children.add(child.id)
                    pending.set(child.id, { project: input.project, segments: source })
                    const interrupt = () => { void ctx.session.interrupt({ sessionID: child.id }).catch(() => undefined) }
                    signal.addEventListener("abort", interrupt, { once: true })
                    try {
                      await ctx.session.prompt({
                        sessionID: child.id,
                        text: prompt(entries, count ? previous.slice(-count) : [], input.targetLanguage, source, input.instructions ?? ""),
                        files: [{ uri: `file://${filename}` }],
                      })
                      await ctx.session.wait({ sessionID: child.id })
                      const submitted = pending.get(child.id)?.translations
                      if (!submitted) throw new Error(`No translation submitted for page ${page}`)
                      await call(client, "edit", { label: `Translate page ${page}`, ops: submitted.map((item) => ({ op: "set_text", layer: item.id, text: item.text })) }, signal)
                      previous.push({ page, translations: submitted.map((item) => ({ ...item, source: source.find((part) => part.id === item.id)?.text ?? "" })) })
                      await ctx.storage.set(priorKey, previous)
                      // The page's text changed, so any earlier typesetting is stale.
                      await forget(page)
                      await journal({ event: "page", page, stage: "translate", attempt: n, ms: Date.now() - started, outcome: "ok", blocks: source.length })
                      stamp()
                      hookOutcomes.push(...await fire("page.translated", {
                        ...globals,
                        page,
                        attempts: n,
                        segments: JSON.stringify(source),
                        source_text: source.map((item) => item.text).join("\n"),
                        translations: JSON.stringify(submitted),
                        translation_text: submitted.map((item) => item.text).join("\n"),
                        glossary: JSON.stringify(Object.fromEntries(entries.map((entry: any) => [entry.source, entry.translation]))),
                        glossary_text: entries.map((entry: any) => `${entry.kind}: ${entry.source} -> ${entry.translation}`).join("\n"),
                        glossary_count: entries.length,
                      }))
                    } finally {
                      signal.removeEventListener("abort", interrupt)
                    }
                  } finally {
                    pending.delete(child.id)
                    if (cleanupSessions) {
                      children.delete(child.id)
                      await ctx.session.remove({ sessionID: child.id }).catch(() => undefined)
                    }
                    await rm(dir, { recursive: true, force: true })
                  }
                } else {
                  await journal({ event: "page", page, stage: "translate", attempt: n, ms: Date.now() - started, outcome: "ok", blocks: 0 })
                }
                const body = json(await call(client, "get_page", { page }, signal))
                pageItems.set(page, blocks(body))
                pageScopes.set(page, layerIds(body))
              }
              for (;;) {
                if (signal.aborted) { failure = failure ?? "aborted"; break }
                attempts++
                try {
                  await attempt(attempts)
                  failure = undefined
                  break
                } catch (error) {
                  failure = String((error as any)?.message ?? error)
                  if (attempts > maxRetries) break
                }
              }
              if (failure !== undefined) {
                failed.push({ page, reason: failure, attempts })
                await journal({ event: "page", page, stage: "translate", ms: Date.now() - started, outcome: "failed", attempts, reason: failure })
                stamp()
                hookOutcomes.push(...await fire("page.failed", { ...globals, page, reason: failure, attempts }))
              }
              if (failure === undefined && (pageItems.get(page)?.length ?? 0) > 0) {
                ready.push({ page, items: pageItems.get(page)!, scopes: pageScopes.get(page)! })
              }
            })
            const translateDone = translateWorkers.finally(() => ready.close())

            // Typesetting flows as pages become ready: inpaint once, then a
            // typesetter session works on the render. A page marked done by an
            // earlier call with the same config is left alone.
            const typesetJob = async ({ page, items, scopes }: { page: string; items: Block[]; scopes: Set<string> }) => {
              const started = Date.now()
              let attempts = 0
              let failure: string | undefined
              if (!retypeset && markers[page]?.config === fingerprint) {
                typeset.push({ page, calls: markers[page].calls, skipped: true })
                await journal({ event: "page", page, stage: "typeset", ms: 0, outcome: "skipped", calls: markers[page].calls })
                return
              }
              const needsPaint = !painted[page]
              if (useLlmTypeset) {
                const base = baseStyleOps(items, langCode)
                if (base.length) await call(client, "edit", { label: `Base style page ${page}`, ops: base }, signal)
              }
              const assertTranslated = async () => {
                const blank = untranslated(json(await call(client, "get_page", { page }, signal)))
                if (blank.length) throw new Error(`Blank translation on ${page}: ${blank.map((item) => item.text).join(", ")}`)
              }
              const typesetPage = async (n: number) => {
                const budget = pageBudget(pageMinutes, items.length)
                if (!useLlmTypeset) {
                  // Default typesetting: the language's translation patch on
                  // every translated block, one atomic edit, no session.
                  const patch: Typesetting | undefined = language !== undefined ? defaultTypesetting[language] : undefined
                  const ops = patch ? typesettingOps(items, patch) : []
                  if (ops.length) await call(client, "edit", { label: `Typeset page ${page}`, ops }, signal)
                  await assertTranslated()
                  typeset.push({ page, calls: 0 })
                  await remember(page, 0)
                  stamp()
                  await journal({ event: "page", page, stage: "typeset", attempt: n, ms: Date.now() - started, outcome: "ok", calls: 0, inpaint: needsPaint })
                  hookOutcomes.push(...await fire("page.typeset", { ...globals, page, calls: 0, attempts: n }))
                  return
                }
                const view = await call(client, "view_page", { page }, signal)
                const attachment = view.content?.find((part: any) => part.type === "image")
                if (!attachment?.data) throw new Error(`No render for page ${page}`)
                const dir = await mkdtemp(join(tmpdir(), "manga-typeset-"))
                const renderFile = join(dir, "render.jpg")
                let child: any
                try {
                  await writeFile(renderFile, Buffer.from(attachment.data, "base64"))
                  const sheet = contactSheet ? await contactSheetFile(renderFile, dir, items) : undefined
                  if (contactSheet && !sheet) await journal({ event: "contact-sheet", page, outcome: "failed" })
                  const parent = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
                  const model = typesetterModel ?? translatorModel ?? parent?.model
                  child = await ctx.session.create({ agent: "manga-typesetter", title: `manga/${input.project}/typeset-${page}`, ...(model ? { model } : {}) })
                  children.add(child.id)
                  typesetTask.set(child.id, {
                    client: client!, signal, page, layers: scopes, translated: new Set(items.map((item) => item.id)),
                    labelOf: new Map(items.map((item) => [item.id, `${item.label} "${item.source}"`])),
                    byLabel: new Map(items.map((item) => [item.label, item.id])),
                    calls: 0, lastOps: 0, render: renderFile, views: 0, dirty: false, followed: false,
                  })
                  const interrupt = () => { void ctx.session.interrupt({ sessionID: child.id }).catch(() => undefined) }
                  signal.addEventListener("abort", interrupt, { once: true })
                  // Time budget: reminders into the running session, never a kill.
                  const reminders = [1, 2].map((step) => setTimeout(async () => {
                    const state = await ctx.session.get({ sessionID: child.id }).catch(() => undefined)
                    const time = state?.time
                    if (time?.idle && time?.busy && time.idle >= time.busy) return
                    await ctx.session.prompt({ sessionID: child.id, text: budgetReminder(budget * step), files: [] }).catch(() => undefined)
                    await journal({ event: "reminder", page, reminder: step, stage: "typeset", budget, blocks: items.length })
                  }, budget * 60 * 1000 * step))
                  try {
                    await ctx.session.prompt({
                      sessionID: child.id,
                      text: typesetPrompt(page, rules, language ?? input.targetLanguage, items, sheet !== undefined),
                      files: [{ uri: `file://${renderFile}` }, ...(sheet ? [{ uri: `file://${sheet}` }] : [])],
                    })
                    await ctx.session.wait({ sessionID: child.id })
                    const task = typesetTask.get(child.id)
                    let calls = task?.calls ?? 0
                    let followed = task?.followed === true
                    // One wrap-up turn after the first edit; never a second.
                    if (!signal.aborted && !followed && needsFollowup(rules, task?.lastOps ?? 0)) {
                      followed = true
                      if (task) task.followed = true
                      await journal({ event: "followup", page, stage: "typeset" })
                      await ctx.session.prompt({ sessionID: child.id, text: followupPrompt, files: [] })
                      await ctx.session.wait({ sessionID: child.id })
                      calls = task?.calls ?? 0
                    }
                    if (rules && !calls) throw new Error("No typeset call despite rules")
                    await assertTranslated()
                    typeset.push({ page, calls })
                    await remember(page, calls)
                    stamp()
                    await journal({ event: "page", page, stage: "typeset", attempt: n, ms: Date.now() - started, outcome: "ok", calls, inpaint: needsPaint, ...(followed ? { followup: 1 } : {}) })
                    hookOutcomes.push(...await fire("page.typeset", { ...globals, page, calls, attempts: n }))
                  } finally {
                    for (const timer of reminders) clearTimeout(timer)
                    signal.removeEventListener("abort", interrupt)
                  }
                } finally {
                  typesetTask.delete(child.id)
                  if (cleanupSessions) {
                    children.delete(child.id)
                    await ctx.session.remove({ sessionID: child.id }).catch(() => undefined)
                  }
                  await rm(dir, { recursive: true, force: true })
                }
              }
              if (!signal.aborted && !painted[page]) {
                // Inpaint once per page: a failed session does not repaint it,
                // and a later retypeset reuses the cleaned page.
                let paints = 0
                for (;;) {
                  try {
                    const ended = await runStage(client, { target: { pages: [page] }, stages: ["inpaint"] }, signal, 30 * 60 * 1000)
                    if (ended.outcome?.kind !== "done") throw new Error(JSON.stringify(ended.outcome))
                    painted[page] = true
                    await ctx.storage.set(paintedKey, painted)
                    break
                  } catch (error) {
                    paints++
                    if (paints > 1) { failure = `inpaint: ${String((error as any)?.message ?? error)}`; break }
                  }
                }
              }
              if (failure === undefined && !signal.aborted) {
                for (;;) {
                  if (signal.aborted) { failure = failure ?? "aborted"; break }
                  attempts++
                  try {
                    await typesetPage(attempts)
                    failure = undefined
                    break
                  } catch (error) {
                    failure = String((error as any)?.message ?? error)
                    if (attempts > maxRetries) break
                  }
                }
              } else if (failure === undefined) {
                failure = "aborted"
              }
              if (failure !== undefined) {
                failed.push({ page, reason: failure, attempts: Math.max(1, attempts) })
                await journal({ event: "page", page, stage: "typeset", ms: Date.now() - started, outcome: "failed", attempts: Math.max(1, attempts), reason: failure })
                stamp()
                hookOutcomes.push(...await fire("page.failed", { ...globals, page, reason: failure, attempts: Math.max(1, attempts) }))
              }
            }
            const typesetWorkers = Promise.all(Array.from({ length: Math.max(1, Math.min(maxTypesets, input.pages.length)) }, async () => {
              for (;;) {
                const job = await ready.next()
                if (job === undefined) return
                await typesetJob(job)
              }
            }))
            await Promise.all([translateDone, typesetWorkers])
            translated = input.pages.filter((item) => !failed.some((entry) => entry.page === item) && (pageItems.get(item) ?? []).every((block) => block.text.trim()))

            // Render, build, and deliver through hooks. The PDF follows the
            // project's page order by default, so a repair of a few pages
            // rebuilds the whole book.
            if (!signal.aborted) {
              const renderPages: string[] = pdfScope === "call" ? [...input.pages] : current.pages.map((page: any) => page.id)
              const outDir = join(ctx.location.directory, "manga", slug, "translated")
              const pagesDir = join(outDir, "pages")
              const partsDir = join(outDir, "parts")
              await rm(pagesDir, { recursive: true, force: true })
              await rm(partsDir, { recursive: true, force: true })
              await mkdir(pagesDir, { recursive: true })
              await mkdir(partsDir, { recursive: true })
              const rendered: string[] = []
              for (let i = 0; i < renderPages.length; i++) {
                const view = await call(client, "view_page", { page: renderPages[i] }, signal)
                const attachment = view.content?.find((part: any) => part.type === "image")
                if (!attachment?.data) throw new Error(`No render for page ${renderPages[i]}`)
                const file = join(pagesDir, `${String(i + 1).padStart(3, "0")}.jpg`)
                await writeFile(file, Buffer.from(attachment.data, "base64"))
                rendered.push(file)
              }
              const dims: { width: number; height: number }[] = []
              for (const file of rendered) dims.push(jpegSize(new Uint8Array(await readFile(file))))
              const width = modalWidth(dims)
              for (let i = 0; i < rendered.length; i++) {
                if (dims[i].width === width) continue
                const resized = `${rendered[i]}.resized.jpg`
                await run(["magick", rendered[i], "-resize", `${width}x`, resized])
                await rename(resized, rendered[i])
              }
              const parts: string[] = []
              for (let i = 0; i < rendered.length; i++) {
                const part = join(partsDir, `${String(i + 1).padStart(3, "0")}.pdf`)
                await run(["magick", rendered[i], "-units", "PixelsPerInch", "-density", "150", part])
                parts.push(part)
              }
              const path = join(outDir, `${sanitized(work)} (translated).pdf`)
              await run(["pdfunite", ...parts, path])
              const size = (await stat(path)).size
              const pdfInfoText = await run(["pdfinfo", "-f", "1", "-l", String(rendered.length), "-box", path], true)
              const info = pdfInfo(pdfInfoText)
              if (info.pages !== undefined && info.pages !== rendered.length) throw new Error(`PDF has ${info.pages} pages, expected ${rendered.length}`)
              pdf = { path, pages: rendered.length, size, ...(info.pageSize ? { pageSize: info.pageSize } : {}) }
              await journal({ event: "pdf", pages: rendered.length, size, path, info })
              stamp()
              hookOutcomes.push(...await fire("pdf.built", { ...globals, pdf: path, file: basename(path), pages: rendered.length, size, pdf_info: pdfInfoText }))
            }
            await saveResult()

            stamp()
            hookOutcomes.push(...await fire("pipeline.completed", {
              ...globals,
              translated: JSON.stringify(translated),
              typeset: JSON.stringify(typeset),
              failed: JSON.stringify(failed),
            }))
            return { content: JSON.stringify({ translated, failed, typeset, pdf, hooks: hookOutcomes, ...(journalError ? { journal: journalError } : {}) }) }
          } finally {
            active.delete(input.project)
            await client?.close()
          }
        },
      })
    })
    return () => {
      controller.abort()
      if (!cleanupSessions) return
      for (const sessionID of children) void ctx.session.remove({ sessionID }).catch(() => undefined)
    }
  },
})
