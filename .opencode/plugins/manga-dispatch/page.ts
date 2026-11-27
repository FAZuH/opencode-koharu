export type Segment = { id: string; text: string }
export type Bounds = { x: number; y: number; width: number; height: number }
export type Block = {
  id: string
  label: string
  source: string
  text: string
  frame: Bounds | null
  width: number | null
  height: number | null
  size: number | null
  role: string | null
  balloon: Bounds | null
}

function text(value: any): string {
  const content = value?.content
  if (!Array.isArray(content)) return ""
  return content.map((span: any) => typeof span?.insert === "string" ? span.insert : "").join("")
}

export function untranslated(page: any): Segment[] {
  const result: Segment[] = []
  function visit(layer: any) {
    if (layer?.kind === "block" && typeof layer.id === "string") {
      const source = text(layer.source)
      if (source.trim() && !text(layer.translation).trim()) result.push({ id: layer.id, text: source })
    }
    for (const child of layer?.children ?? []) visit(child)
  }
  for (const layer of page?.layers ?? []) visit(layer)
  return result
}

/** Accept arrays, wrapped arrays, and one or two layers of JSON stringification. */
export function parseSubmitTranslations(input: unknown): unknown[] {
  let value = input
  for (let pass = 0; pass < 4; pass++) {
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed) break
      try {
        value = JSON.parse(trimmed)
      } catch {
        break
      }
      continue
    }
    if (Array.isArray(value)) {
      if (!value.length) throw new Error("Submit a non-empty list of translations")
      return value
    }
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).translations
      if (Array.isArray(nested)) {
        if (!nested.length) throw new Error("Submit a non-empty list of translations")
        return nested
      }
      if (typeof nested === "string") {
        value = nested
        continue
      }
    }
    break
  }
  throw new Error("Submit translations as an array, or an object with a translations array")
}

export function validate(segments: Segment[], translations: Segment[]): void {
  const expected = new Set(segments.map((segment) => segment.id))
  const ids = new Set<string>()
  for (const item of translations) {
    if (!expected.has(item.id) || ids.has(item.id) || !item.text.trim()) throw new Error("Invalid translation IDs or empty text")
    ids.add(item.id)
  }
  if (ids.size !== expected.size) throw new Error("Every source block must be translated exactly once")
}

function pairs(entries: unknown, keys: string[]): string[] {
  if (Array.isArray(entries)) {
    return entries.map((entry: any) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const source = String(entry.source ?? keys[0] ?? "")
        const translation = String(entry.translation ?? keys[1] ?? "")
        return `${source} → ${translation}`
      }
      return String(entry)
    })
  }
  if (entries && typeof entries === "object") {
    return Object.entries(entries as Record<string, unknown>).map(([source, translation]) => `${source} → ${String(translation)}`)
  }
  return []
}

/** Translator prompt: numbered source lines, no project or segment ids. */
export function prompt(entries: unknown, prior: unknown, language: string, segments: Segment[], instructions: string): string {
  const byId = new Map(segments.map((segment) => [segment.id, segment.text]))
  const recent: string[] = []
  for (const item of Array.isArray(prior) ? prior : []) {
    for (const translation of Array.isArray((item as any)?.translations) ? (item as any).translations : []) {
      if (translation && typeof translation === "object") {
        recent.push(`${String(translation.source ?? byId.get(translation.id) ?? translation.id)} → ${String(translation.text)}`)
      }
    }
  }
  const header = [
    `Translate every source line into ${language}. Use the glossary and keep names consistent.`,
    "Read the page image for speaker and tone. SFX become English, never romanized. Keep hearts (♡).",
    ...(instructions.trim() ? [`work_instructions: ${instructions.trim()}`] : []),
  ].join("\n")
  return [
    header,
    "",
    "glossary:",
    ...pairs(entries, ["source", "translation"]),
    "",
    "recent:",
    ...recent,
    "",
    "page:",
    ...segments.map((segment, index) => `${index + 1}. ${segment.text}`),
  ].join("\n")
}

function bounds(value: any): Bounds | null {
  if (!value || typeof value !== "object") return null
  const box = value.x !== undefined ? value : value.bounds
  if (!box || typeof box.x !== "number" || typeof box.y !== "number" || typeof box.width !== "number" || typeof box.height !== "number") return null
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/** Translated blocks with page-local labels and only the fields the agent edits. */
export function blocks(page: any): Block[] {
  const result: Block[] = []
  function visit(layer: any, balloon: Bounds | null) {
    if (layer?.kind === "balloon") {
      const here = bounds(layer.bounds)
      if (here) balloon = here
    }
    if (layer?.kind === "block" && typeof layer.id === "string") {
      const translation = text(layer.translation)
      if (translation.trim()) {
        const frame = bounds(layer.translation?.frame?.box?.bounds) ?? bounds(layer.source?.frame?.box?.bounds)
        result.push({
          id: layer.id,
          label: `b${result.length + 1}`,
          source: text(layer.source),
          text: translation,
          frame,
          width: frame?.width ?? null,
          height: frame?.height ?? null,
          size: typeof layer.source?.style?.chars?.size === "number" ? layer.source.style.chars.size : null,
          role: typeof layer.role === "string" ? layer.role : null,
          balloon,
        })
      }
    }
    for (const child of layer?.children ?? []) visit(child, balloon)
  }
  for (const layer of page?.layers ?? []) visit(layer, null)
  return result
}

/** One prompt line per block: label, source, translation and box size. */
export function blockLines(items: Block[]): string[] {
  return items.map((item) => `${item.label} ${JSON.stringify(item.source)} → ${JSON.stringify(item.text)} [${item.width ?? 0}x${item.height ?? 0}]`)
}

/** `en` becomes `RULES_EN.md`; the file the plugin injects for a language code. */
export function rulesFile(code: string): string {
  return `RULES_${code.toUpperCase()}.md`
}

/** Typesetter prompt: rules first, then page-local labels. No UUIDs or page id. */
export function typesetPrompt(_page: string, rules: string, language: string, items: Block[], sheet = false): string {
  const attachments = sheet
    ? "\nA contact sheet of labeled block crops follows the render; judge each label from the sheet."
    : ""
  return [
    `Typeset this page in ${language}. One manga_typeset call, then one manga_view check.`,
    `Rules: ${rules.trim() || "(none)"}`,
    attachments,
    "",
    "blocks:",
    ...blockLines(items),
  ].join("\n")
}

/** A partial Koharu translation object: the fields a default may set. */
export type TypesettingStyle = {
  chars?: { family?: string; weight?: number; italic?: boolean; size?: number; fill?: number[]; stroke?: number[]; stroke_width?: number }
  align?: "start" | "center" | "end" | "justify"
  line_height?: number
}
export type Typesetting = {
  direction?: "horizontal" | "vertical"
  style?: TypesettingStyle
  frame?: { box: { fit?: "shrink" | "none" | "grow" | "best"; anchor?: "start" | "center" | "end" } }
  language?: string
}

const directions = ["horizontal", "vertical"]
const aligns = ["start", "center", "end", "justify"]
const fits = ["shrink", "none", "grow", "best"]
const anchors = ["start", "center", "end"]
const charFields = ["family", "weight", "italic", "size", "fill", "stroke", "stroke_width"]

function oneOf(value: unknown, allowed: string[], where: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${where} must be one of ${allowed.join(", ")}`)
  return value
}

function colour(value: unknown, where: string): number[] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === "number" && part >= 0 && part <= 1)) {
    throw new Error(`${where} must be four numbers from 0 to 1`)
  }
  return value
}

/** Checked `defaultTypesetting`: a language code to a partial translation. */
export function typesettingDefaults(config: unknown): Record<string, Typesetting> {
  if (config === undefined) return {}
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("defaultTypesetting must map a language slug to its typesetting settings")
  const result: Record<string, Typesetting> = {}
  for (const [key, raw] of Object.entries(config as Record<string, unknown>)) {
    if (!/^[a-z]{2}$/.test(key)) throw new Error(`defaultTypesetting keys are 2-letter language codes, not ${JSON.stringify(key)}`)
    const where = `defaultTypesetting[${key}]`
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where} must be an object`)
    const settings = raw as Record<string, any>
    for (const field of Object.keys(settings)) {
      if (field === "content" || field === "transform") throw new Error(`${where}.${field} is per block, not a default`)
      if (!["direction", "style", "frame", "language"].includes(field)) throw new Error(`${where}.${field} is not a typesetting field; expected direction, style, frame, language`)
    }
    const patch: Typesetting = {}
    if (settings.direction !== undefined) patch.direction = oneOf(settings.direction, directions, `${where}.direction`) as Typesetting["direction"]
    if (settings.language !== undefined) {
      if (typeof settings.language !== "string" || !settings.language) throw new Error(`${where}.language must be a non-empty string`)
      patch.language = settings.language
    }
    if (settings.style !== undefined) {
      if (typeof settings.style !== "object" || settings.style === null || Array.isArray(settings.style)) throw new Error(`${where}.style must be an object`)
      const style = settings.style as Record<string, any>
      for (const field of Object.keys(style)) {
        if (!["chars", "align", "line_height"].includes(field)) throw new Error(`${where}.style.${field} is not a style field; expected chars, align, line_height`)
      }
      const checked: TypesettingStyle = {}
      if (style.align !== undefined) checked.align = oneOf(style.align, aligns, `${where}.style.align`) as TypesettingStyle["align"]
      if (style.line_height !== undefined) {
        if (typeof style.line_height !== "number" || !Number.isFinite(style.line_height) || style.line_height <= 0) throw new Error(`${where}.style.line_height must be a positive number`)
        checked.line_height = style.line_height
      }
      if (style.chars !== undefined) {
        if (typeof style.chars !== "object" || style.chars === null || Array.isArray(style.chars)) throw new Error(`${where}.style.chars must be an object`)
        const chars = style.chars as Record<string, any>
        for (const field of Object.keys(chars)) {
          if (!charFields.includes(field)) throw new Error(`${where}.style.chars.${field} is not a character field; expected ${charFields.join(", ")}`)
        }
        const checkedChars: Record<string, unknown> = {}
        if (chars.family !== undefined) {
          if (typeof chars.family !== "string" || !chars.family) throw new Error(`${where}.style.chars.family must be a non-empty string`)
          checkedChars.family = chars.family
        }
        if (chars.weight !== undefined) {
          if (!Number.isInteger(chars.weight) || chars.weight < 1 || chars.weight > 1000) throw new Error(`${where}.style.chars.weight must be an integer from 1 to 1000`)
          checkedChars.weight = chars.weight
        }
        if (chars.italic !== undefined) {
          if (typeof chars.italic !== "boolean") throw new Error(`${where}.style.chars.italic must be a boolean`)
          checkedChars.italic = chars.italic
        }
        if (chars.size !== undefined) {
          if (typeof chars.size !== "number" || !Number.isFinite(chars.size) || chars.size <= 0) throw new Error(`${where}.style.chars.size must be a positive number`)
          checkedChars.size = chars.size
        }
        if (chars.fill !== undefined) checkedChars.fill = colour(chars.fill, `${where}.style.chars.fill`)
        if (chars.stroke !== undefined) checkedChars.stroke = colour(chars.stroke, `${where}.style.chars.stroke`)
        if (chars.stroke_width !== undefined) {
          if (typeof chars.stroke_width !== "number" || !Number.isFinite(chars.stroke_width) || chars.stroke_width < 0) throw new Error(`${where}.style.chars.stroke_width must be a non-negative number`)
          checkedChars.stroke_width = chars.stroke_width
        }
        checked.chars = checkedChars as TypesettingStyle["chars"]
      }
      patch.style = checked
    }
    if (settings.frame !== undefined) {
      if (typeof settings.frame !== "object" || settings.frame === null || Array.isArray(settings.frame)) throw new Error(`${where}.frame must be { box: { fit, anchor } }`)
      const frame = settings.frame as Record<string, any>
      for (const field of Object.keys(frame)) {
        if (field === "bounds") throw new Error(`${where}.frame.bounds is per block, not a default`)
        if (field !== "box") throw new Error(`${where}.frame.${field} is not applicable; use box`)
      }
      if (typeof frame.box !== "object" || frame.box === null || Array.isArray(frame.box)) throw new Error(`${where}.frame.box must be an object`)
      const box: Record<string, unknown> = {}
      for (const field of Object.keys(frame.box)) {
        if (field === "bounds") throw new Error(`${where}.frame.box.bounds is per block, not a default`)
        if (!["fit", "anchor"].includes(field)) throw new Error(`${where}.frame.box.${field} is not a box field; expected fit, anchor`)
      }
      if (frame.box.fit !== undefined) box.fit = oneOf(frame.box.fit, fits, `${where}.frame.box.fit`)
      if (frame.box.anchor !== undefined) box.anchor = oneOf(frame.box.anchor, anchors, `${where}.frame.box.anchor`)
      patch.frame = { box } as Typesetting["frame"]
    }
    result[key] = patch
  }
  return result
}

/** One `update_layer` per block, applying a default only where it fits. */
export function typesettingOps(items: Block[], patch: Typesetting): any[] {
  const ops: any[] = []
  for (const item of items) {
    const translation: Record<string, unknown> = {}
    if (patch.direction !== undefined) translation.direction = patch.direction
    if (patch.style !== undefined) translation.style = patch.style
    if (patch.language !== undefined) translation.language = patch.language
    if (patch.frame !== undefined && item.frame !== null) translation.frame = patch.frame
    if (Object.keys(translation).length) ops.push({ op: "update_layer", layer: item.id, patch: { translation } })
  }
  return ops
}

function nudge(frame: Bounds, balloon: Bounds): [number, number] {
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))
  const dx = clamp(balloon.x + balloon.width / 2 - (frame.x + frame.width / 2), balloon.width / 2)
  const dy = clamp(balloon.y + balloon.height / 2 - (frame.y + frame.height / 2), balloon.height / 2)
  return [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100]
}

/** Deterministic base style, applied once before a typesetter session. */
export function baseStyleOps(items: Block[], language: string): any[] {
  const ops: any[] = []
  for (const item of items) {
    const chars: Record<string, unknown> = {}
    if (item.frame !== null && item.size !== null) chars.size = item.size
    if (item.role === "sfx") Object.assign(chars, { fill: [1, 1, 1, 1], stroke: [0, 0, 0, 1], stroke_width: 2 })
    const style: Record<string, unknown> = { align: "center" }
    if (Object.keys(chars).length) style.chars = chars
    const translation: Record<string, unknown> = { direction: "horizontal", language, style }
    if (item.frame !== null) translation.frame = { box: { fit: "best" } }
    ops.push({ op: "update_layer", layer: item.id, patch: { translation } })
    if (item.frame && item.balloon) {
      const [dx, dy] = nudge(item.frame, item.balloon)
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) ops.push({ op: "transform_layer", layer: item.id, transform: [[1, 0, dx], [0, 1, dy]] })
    }
  }
  return ops
}

/** Every layer id on the page, blocks and containers included. */
export function layerIds(page: any): Set<string> {
  const ids = new Set<string>()
  function visit(layer: any) {
    if (typeof layer?.id === "string") ids.add(layer.id)
    for (const child of layer?.children ?? []) visit(child)
  }
  for (const layer of page?.layers ?? []) visit(layer)
  return ids
}

const letteringOps = ["set_text", "set_rich_text", "update_layer", "transform_layer"]

function describe(ref: unknown, names: ReadonlyMap<string, string> | undefined, page: string): string {
  if (typeof ref !== "string") return String(ref)
  if (names?.has(ref)) return names.get(ref)!
  return ref === page ? `page ${page}` : ref
}

function blankSpans(spans: unknown): boolean {
  return !Array.isArray(spans) || !spans.some((span: any) => typeof span?.insert === "string" && span.insert.trim())
}

/** Resolve page-local bN labels to layer ids before the op is checked. */
export function resolveLabels(ops: unknown, byLabel: ReadonlyMap<string, string>): any[] {
  const list = Array.isArray(ops) ? ops : []
  return list.map((op: any) => {
    const ref = op?.layer
    if (typeof ref !== "string") return op
    if (byLabel.has(ref)) return { ...op, layer: byLabel.get(ref) }
    if (/^b\d+$/.test(ref)) throw new Error(`Unknown block label ${ref}`)
    return op
  })
}

/** Lettering-only, page-scoped edit ops; a refusal names the op and block. */
export function scopeEditOps(
  ops: unknown,
  page: string,
  layers: ReadonlySet<string>,
  names?: ReadonlyMap<string, string>,
  translated?: ReadonlySet<string>,
): any[] {
  if (!Array.isArray(ops)) throw new Error("ops must be an array")
  const writable = translated ?? layers
  ops.forEach((op: any, index: number) => {
    if (typeof op?.op !== "string") throw new Error(`op ${index}: each op needs an op name`)
    if (!letteringOps.includes(op.op)) throw new Error(`op ${index}: ${op.op} is not a lettering op; add, remove, duplicate, move, background, attribute and page ops are rejected`)
    if (op.page !== undefined) throw new Error(`op ${index}: ${op.op} touches a page; page ops are rejected`)
    if (typeof op.layer !== "string") throw new Error(`op ${index}: ${op.op} takes a layer`)
    const label = describe(op.layer, names, page)
    if (!layers.has(op.layer) && !op.layer.startsWith("$")) throw new Error(`op ${index}: ${op.op} touches ${label}, which is out of scope`)
    if (!writable.has(op.layer)) throw new Error(`op ${index}: ${op.op} touches ${label}, which is not a translated block of this session`)
    if (op.op === "set_text" && (typeof op.text !== "string" || !op.text.trim())) throw new Error(`op ${index}: set_text on ${label} cannot be blank`)
    if (op.op === "set_rich_text" && blankSpans(op.spans)) throw new Error(`op ${index}: set_rich_text on ${label} cannot be blank`)
    if (op.op === "update_layer") {
      const patch = op.patch
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error(`op ${index}: update_layer on ${label} takes a patch`)
      const extra = Object.keys(patch).filter((key) => key !== "translation")
      if (extra.length) throw new Error(`op ${index}: update_layer on ${label} patches ${extra.join(", ")}; only translation is allowed`)
      const value = patch.translation
      const cleared = value === null || (value && typeof value === "object" && Object.hasOwn(value, "content") && (
        value.content === null || (typeof value.content === "string" && !value.content.trim()) || (Array.isArray(value.content) && blankSpans(value.content))
      ))
      if (cleared) throw new Error(`op ${index}: update_layer on ${label} cannot clear translation.content`)
    }
    if (op.op === "transform_layer") {
      const matrix = op.transform
      if (!Array.isArray(matrix) || matrix.length !== 2 || !matrix.every((row: any) => Array.isArray(row) && row.length === 3 && row.every((part: any) => typeof part === "number" && Number.isFinite(part)))) {
        throw new Error(`op ${index}: transform_layer on ${label} takes a 2x3 numeric transform`)
      }
    }
  })
  return ops
}

/** `{{key}}` substitution for hook arguments; an unknown key stays visible. */
export function substitute(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => Object.hasOwn(vars, key) ? String(vars[key]) : whole)
}

/** Minutes a page may run: the base, a quarter-minute per block, capped at twice the base. */
export function pageBudget(base: number, blocks: number): number {
  if (!Number.isFinite(base) || base <= 0) throw new Error("pageMinutes must be a positive number")
  if (!Number.isFinite(blocks) || blocks < 0) throw new Error("blocks must be a non-negative number")
  return Math.min(base * 2, base + blocks / 4)
}

/** Whether a finished typesetter session needs one wrap-up turn after an edit. */
export function needsFollowup(_rules: string, lastOps: number): boolean {
  return lastOps > 0
}

/** Runs `worker` over `items`, at most `limit` at a time. */
export async function pool<T>(limit: number, items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const count = Math.max(1, Math.min(limit, queue.length))
  await Promise.all(Array.from({ length: count }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  }))
}

/** A many-producer, many-consumer queue that consumers await until closed. */
export function jobQueue<T>() {
  const items: T[] = []
  const waiters = new Set<() => void>()
  let closed = false
  const wake = () => { for (const waiter of [...waiters]) waiter(); waiters.clear() }
  return {
    push(item: T) {
      if (closed) throw new Error("queue is closed")
      items.push(item)
      wake()
    },
    close() {
      closed = true
      wake()
    },
    async next(): Promise<T | undefined> {
      for (;;) {
        if (items.length) return items.shift()
        if (closed) return undefined
        await new Promise<void>((resolve) => waiters.add(resolve))
      }
    },
  }
}

/** The width and height of a JPEG, from its frame header. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue }
    const marker = bytes[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3])
  }
  throw new Error("not a JPEG")
}

/** The most common width, so every page of a PDF has the same one. */
export function modalWidth(dims: { width: number }[]): number {
  const counts = new Map<number, number>()
  let best = dims[0]?.width
  let bestCount = 0
  for (const { width } of dims) {
    const count = (counts.get(width) ?? 0) + 1
    counts.set(width, count)
    if (count > bestCount) { best = width; bestCount = count }
  }
  if (best === undefined) throw new Error("no pages to measure")
  return best
}

/** Page count and file size from `pdfinfo` output. */
export function pdfInfo(text: string): { pages?: number; fileSize?: number; pageSize?: string } {
  const pages = text.match(/^\s*Pages:\s*(\d+)/m)
  const size = text.match(/^\s*File size:\s*(\d+)/m)
  const pageSize = text.match(/^\s*Page size:\s*(.+)$/m)
  return {
    ...(pages ? { pages: Number(pages[1]) } : {}),
    ...(size ? { fileSize: Number(size[1]) } : {}),
    ...(pageSize ? { pageSize: pageSize[1].trim() } : {}),
  }
}

export type OcrWord = { text: string; conf: number; box: Bounds }

/** Word boxes from tesseract TSV output, above a confidence threshold. */
export function ocrWords(tsv: string, minConf = 10): OcrWord[] {
  const lines = tsv.trim().split("\n")
  const head = lines.shift()?.split("\t") ?? []
  const at = (name: string) => head.indexOf(name)
  const left = at("left"), top = at("top"), width = at("width"), height = at("height"), conf = at("conf"), body = at("text")
  if ([left, top, width, height, conf, body].some((index) => index < 0)) return []
  const words: OcrWord[] = []
  for (const line of lines) {
    const cells = line.split("\t")
    const value = cells[body]?.trim()
    const confidence = Number(cells[conf])
    if (!value || value.startsWith("[") || !Number.isFinite(confidence) || confidence < minConf) continue
    words.push({
      text: value,
      conf: confidence,
      box: { x: Number(cells[left]), y: Number(cells[top]), width: Number(cells[width]), height: Number(cells[height]) },
    })
  }
  return words
}

/** The cover title edit: a top-level text block with no mask, since MCP cannot write mask pixels. */
export function coverBlockOps(page: string, title: { text: string; box: Bounds }): any[] {
  return [{
    op: "add_layer",
    page,
    index: 0,
    layer: {
      kind: "block",
      role: "text",
      source: { content: [{ insert: title.text }], frame: { box: { bounds: title.box } } },
    },
  }]
}

function titleWord(value: string): boolean {
  return /^[\p{L}][\p{L}♡'’\-]*$/u.test(value.trim())
}

/** A title box spanning top-band OCR words, or undefined when OCR found no title. */
export function coverBox(words: OcrWord[], pageHeight?: number): { text: string; box: Bounds } | undefined {
  const band = typeof pageHeight === "number" && pageHeight > 0 ? pageHeight * 0.35 : undefined
  const inBand = words.filter((word) => band === undefined || word.box.y + word.box.height / 2 < band)
  const accepted = inBand.filter((word) => titleWord(word.text))
  const rejected = inBand.length - accepted.length
  if (accepted.length < 2 || rejected * 3 > accepted.length) return undefined
  const text = accepted.map((word) => word.text.trim()).join(" ").trim()
  if ((text.match(/[\p{L}]/gu) ?? []).length < 6) return undefined
  const x0 = Math.min(...accepted.map((word) => word.box.x))
  const y0 = Math.min(...accepted.map((word) => word.box.y))
  const x1 = Math.max(...accepted.map((word) => word.box.x + word.box.width))
  const y1 = Math.max(...accepted.map((word) => word.box.y + word.box.height))
  return { text, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
}

/** CJK characters left in a translation, for deterministic auditing. */
export function cjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

/** Duplicate frame keys on a page, grouped by their bounds. */
export function duplicateFrames(page: any): { frame: Bounds; labels: string[] }[] {
  const seen = new Map<string, { frame: Bounds; labels: string[] }>()
  function visit(layer: any, label: string) {
    const frame = bounds(layer?.translation?.frame?.box?.bounds) ?? bounds(layer?.source?.frame?.box?.bounds)
    if (frame) {
      const key = [frame.x, frame.y, frame.width, frame.height].join(",")
      const entry = seen.get(key) ?? { frame, labels: [] }
      entry.labels.push(label)
      seen.set(key, entry)
    }
    for (const child of layer?.children ?? []) visit(child, label)
  }
  for (const layer of page?.layers ?? []) visit(layer, typeof layer?.id === "string" ? layer.id.slice(-6) : "?")
  return [...seen.values()].filter((entry) => entry.labels.length > 1)
}
