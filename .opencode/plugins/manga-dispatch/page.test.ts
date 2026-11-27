import { expect, test } from "bun:test"
import {
  baseStyleOps, blocks, blockLines, cjk, coverBlockOps, coverBox, duplicateFrames, jobQueue, jpegSize,
  modalWidth, needsFollowup, ocrWords, pageBudget, parseSubmitTranslations, pdfInfo, pool, prompt, resolveLabels, rulesFile,
  scopeEditOps, substitute, typesetPrompt, typesettingDefaults, typesettingOps,
  untranslated, validate,
} from "./page"
import type { OcrWord } from "./page"

const ocrRow = (texts: string[]): OcrWord[] => texts.map((text, index) => ({
  text, conf: 90, box: { x: 10 + index * 100, y: 20, width: 80, height: 30 },
}))

test("submit parser accepts a plain array", () => {
  expect(parseSubmitTranslations(["a", "b"])).toEqual(["a", "b"])
  expect(parseSubmitTranslations([{ n: 1, text: "A" }])).toEqual([{ n: 1, text: "A" }])
})

test("submit parser accepts an object with an array", () => {
  expect(parseSubmitTranslations({ translations: ["a", "b"] })).toEqual(["a", "b"])
})

test("submit parser accepts an object with a JSON-string array", () => {
  expect(parseSubmitTranslations({ translations: '["a","b"]' })).toEqual(["a", "b"])
})

test("submit parser accepts an object with a JSON-string of {n,text} objects", () => {
  expect(parseSubmitTranslations({ translations: '[{"n":1,"text":"A"},{"n":2,"text":"B"}]' })).toEqual([{ n: 1, text: "A" }, { n: 2, text: "B" }])
})

test("submit parser accepts a top-level JSON string", () => {
  expect(parseSubmitTranslations('["a","b"]')).toEqual(["a", "b"])
  expect(parseSubmitTranslations('{"translations":["a","b"]}')).toEqual(["a", "b"])
})

test("submit parser accepts double-stringified JSON", () => {
  expect(parseSubmitTranslations(JSON.stringify(JSON.stringify(["a", "b"])))).toEqual(["a", "b"])
})

test("submit parser rejects garbage, empty and empty-array input", () => {
  expect(() => parseSubmitTranslations("not json")).toThrow()
  expect(() => parseSubmitTranslations("")).toThrow()
  expect(() => parseSubmitTranslations({ translations: "" })).toThrow()
  expect(() => parseSubmitTranslations({ translations: [] })).toThrow(/non-empty/)
  expect(() => parseSubmitTranslations({})).toThrow()
})

const block = (id: string, source: string, translation: string | null, extra: Record<string, unknown> = {}) => ({
  kind: "block", id, role: "other",
  source: { content: [{ insert: source }] },
  translation: translation === null ? null : { content: [{ insert: translation }], ...extra },
})

test("extracts untranslated nested blocks and preserves IDs", () => {
  const page = { layers: [{ kind: "panel", children: [
    block("a", "原", null),
    block("b", "既存", "existing"),
  ] }] }
  expect(untranslated(page)).toEqual([{ id: "a", text: "原" }])
})

test("validates complete unique translations and rejects blanks", () => {
  const segments = [{ id: "a", text: "原" }, { id: "b", text: "文" }]
  expect(() => validate(segments, [{ id: "a", text: "A" }, { id: "b", text: "B" }])).not.toThrow()
  expect(() => validate(segments, [{ id: "a", text: "A" }])).toThrow()
  expect(() => validate(segments, [{ id: "a", text: "A" }, { id: "a", text: "B" }])).toThrow()
  expect(() => validate(segments, [{ id: "a", text: "A" }, { id: "c", text: "B" }])).toThrow()
  expect(() => validate(segments, [{ id: "a", text: "A" }, { id: "b", text: "  " }])).toThrow()
})

test("prompt uses numbered lines, arrows and no UUIDs", () => {
  const value = prompt(
    [{ source: "お風呂", translation: "bath" }],
    [{ page: "p0", translations: [{ id: "old-id", source: "派派", text: "Piper" }] }],
    "English",
    [{ id: "aaaaaaaa-1111-2222-3333-444444444444", text: "好啦〜準備好囉〜" }, { id: "bbbbbbbb-1111-2222-3333-444444444444", text: "恩♡" }],
    "",
  )
  expect(value.startsWith("Translate every source line into English.")).toBe(true)
  expect(value).toContain("glossary:\nお風呂 → bath")
  expect(value).toContain("recent:\n派派 → Piper")
  expect(value).toContain("page:\n1. 好啦〜準備好囉〜\n2. 恩♡")
  expect(value.indexOf("glossary:")).toBeLessThan(value.indexOf("page:"))
  expect(value).not.toContain("aaaaaaaa")
  expect(value).not.toContain("old-id")
  expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
})

test("prompt carries work instructions and handles map-style glossary", () => {
  const value = prompt({ 名前: "Name" }, [], "English", [{ id: "a", text: "原" }], "Keep names")
  expect(value).toContain("work_instructions: Keep names")
  expect(value).toContain("名前 → Name")
})

test("blocks emits page-local labels and only source, translation and size", () => {
  const page = { layers: [
    block("real-a", "原", "text", { frame: { box: { bounds: { x: 1, y: 2, width: 3, height: 4 } } } }),
    block("real-b", "未", null),
    block("real-c", "既", "done"),
  ] }
  const items = blocks(page)
  expect(items.map((item) => item.label)).toEqual(["b1", "b2"])
  expect(items[0].id).toBe("real-a")
  expect(items[0].frame).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  expect(blockLines(items)).toEqual([
    'b1 "原" → "text" [3x4]',
    'b2 "既" → "done" [0x0]',
  ])
  expect(blockLines(items).join("\n")).not.toContain("real-a")
})

test("blocks finds the owning balloon through the layer tree", () => {
  const page = { layers: [{ kind: "balloon", bounds: { x: 0, y: 0, width: 200, height: 300 }, children: [
    block("a", "原", "text", { frame: { box: { bounds: { x: 10, y: 20, width: 40, height: 30 } } } }),
  ] }] }
  expect(blocks(page)[0].balloon).toEqual({ x: 0, y: 0, width: 200, height: 300 })
})

test("baseStyleOps sets direction, align, language, fit, SFX contrast and balloon centring", () => {
  const page = { layers: [{ kind: "balloon", bounds: { x: 0, y: 0, width: 200, height: 300 }, children: [
    { ...block("a", "原", "text", { frame: { box: { bounds: { x: 10, y: 20, width: 40, height: 30 } } } }), role: "sfx" },
  ] }] }
  const ops = baseStyleOps(blocks(page), "en")
  expect(ops[0]).toEqual({ op: "update_layer", layer: "a", patch: { translation: {
    direction: "horizontal", language: "en",
    style: { align: "center", chars: { fill: [1, 1, 1, 1], stroke: [0, 0, 0, 1], stroke_width: 2 } },
    frame: { box: { fit: "best" } },
  } } })
  expect(ops[1]).toEqual({ op: "transform_layer", layer: "a", transform: [[1, 0, 70], [0, 1, 115]] })
  const plain = baseStyleOps([{ ...blocks({ layers: [block("p", "x", "y")] })[0] }], "en")
  expect(plain[0].patch.translation.style).toEqual({ align: "center" })
  expect(plain[0].patch.translation.frame).toBeUndefined()
})

test("baseStyleOps keeps a fitting source size", () => {
  const page = { layers: [{
    ...block("a", "原", "text", { frame: { box: { bounds: { x: 1, y: 2, width: 40, height: 30 } } } }),
    source: { content: [{ insert: "原" }], style: { chars: { size: 34 } } },
  }] }
  const ops = baseStyleOps(blocks(page), "en")
  expect(ops[0].patch.translation.style.chars).toEqual({ size: 34 })
  expect(ops[0].patch.translation.frame).toEqual({ box: { fit: "best" } })
})

test("typesetPrompt puts rules before short labeled blocks and no page id", () => {
  const items = blocks({ layers: [block("id-123", "原", "text")] })
  const value = typesetPrompt("page-secret", "RULE ONE", "en", items)
  expect(value.startsWith("Typeset this page in en.")).toBe(true)
  expect(value.indexOf("RULE ONE")).toBeLessThan(value.indexOf("blocks:"))
  expect(value).toContain('b1 "原" → "text"')
  expect(value).not.toContain("page-secret")
  expect(value).not.toContain("id-123")
})

test("typesetPrompt mentions the contact sheet only when one is attached", () => {
  const plain = typesetPrompt("page-1", "RULES", "en", [])
  const sheet = typesetPrompt("page-1", "RULES", "en", [], true)
  expect(plain).not.toContain("contact sheet")
  expect(sheet).toContain("contact sheet")
  expect(sheet).toContain("One manga_typeset call")
  expect(sheet.indexOf("Typeset this page")).toBe(0)
})

test("scopeEditOps allows lettering ops and names the block in refusals", () => {
  const layers = new Set(["block-a", "block-b", "raster-1"])
  const translated = new Set(["block-a", "block-b"])
  const names = new Map([["block-a", 'b1 "原"'], ["block-b", 'b2 "文"']])
  const ops = [
    { op: "update_layer", layer: "block-a", patch: { translation: { style: { chars: { size: 40 } } } } },
    { op: "set_text", layer: "block-b", text: "New" },
    { op: "set_rich_text", layer: "block-b", spans: [{ insert: "New" }] },
    { op: "transform_layer", layer: "block-a", transform: [[1, 0, 2], [0, 1, 3]] },
  ]
  expect(scopeEditOps(ops, "page-1", layers, names, translated)).toEqual(ops)
  expect(() => scopeEditOps([{ op: "update_layer", layer: "other-page-block", patch: {} }], "page-1", layers, names, translated)).toThrow(/other-page-block.*out of scope/)
  expect(() => scopeEditOps([{ op: "set_text", layer: "raster-1", text: "x" }], "page-1", layers, names, translated)).toThrow(/raster-1.*not a translated block/)
})

test("scopeEditOps rejects structural, page and attribute ops by name", () => {
  for (const op of ["add_layer", "remove_layer", "duplicate_layer", "move_layer", "set_background", "set_attribute", "remove_page", "add_page"]) {
    expect(() => scopeEditOps([{ op, layer: "block-a" }], "page-1", new Set(["block-a"]), new Map(), new Set(["block-a"]))).toThrow(new RegExp(`${op} is not a lettering op`))
  }
  expect(() => scopeEditOps([{ op: "set_text", layer: "b1", text: "x", page: "page-1" }], "page-1", new Set(["b1"]), new Map(), new Set(["b1"]))).toThrow(/page ops are rejected/)
  expect(() => scopeEditOps([{ op: "update_layer", patch: {} }], "page-1", new Set(), undefined, undefined)).toThrow(/takes a layer/)
  expect(() => scopeEditOps([{ op: "frobnicate", layer: "block-a" }], "page-1", new Set(["block-a"]), new Map(), new Set(["block-a"]))).toThrow(/unknown|not a lettering op/)
  expect(() => scopeEditOps("nope", "page-1", new Set())).toThrow()
})

test("scopeEditOps rejects blank text and patches that clear a translation", () => {
  const layers = new Set(["block-a"])
  const names = new Map([["block-a", 'b1 "原"']])
  expect(() => scopeEditOps([{ op: "set_text", layer: "block-a", text: "" }], "page-1", layers, names, layers)).toThrow(/b1 "原".*cannot be blank/)
  expect(() => scopeEditOps([{ op: "set_text", layer: "block-a", text: "  " }], "page-1", layers, names, layers)).toThrow(/cannot be blank/)
  expect(() => scopeEditOps([{ op: "set_rich_text", layer: "block-a", spans: [{ insert: " " }] }], "page-1", layers, names, layers)).toThrow(/cannot be blank/)
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { translation: null } }], "page-1", layers, names, layers)).toThrow(/cannot clear translation.content/)
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { translation: { content: [] } } }], "page-1", layers, names, layers)).toThrow(/cannot clear translation.content/)
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { translation: { content: [{ insert: "" }] } } }], "page-1", layers, names, layers)).toThrow(/cannot clear translation.content/)
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { translation: { content: [{ insert: " " }] } } }], "page-1", layers, names, layers)).toThrow(/cannot clear translation.content/)
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { translation: { content: [{ insert: "Hello" }] } } }], "page-1", layers, names, layers)).not.toThrow()
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { translation: { content: "Hello" } } }], "page-1", layers, names, layers)).not.toThrow()
  expect(() => scopeEditOps([{ op: "update_layer", layer: "block-a", patch: { source: { content: [] } } }], "page-1", layers, names, layers)).toThrow(/only translation is allowed/)
})

test("rulesFile uppercases the language code", () => {
  expect(rulesFile("en")).toBe("RULES_EN.md")
  expect(rulesFile("JA")).toBe("RULES_JA.md")
})

test("substitute replaces known keys and keeps unknown ones", () => {
  const vars = { pdf: "/tmp/a b.pdf", multi: "one\ntwo" }
  expect(substitute("send {{pdf}}", vars)).toBe("send /tmp/a b.pdf")
  expect(substitute("{{multi}}", vars)).toBe("one\ntwo")
  expect(substitute("{{missing}}", vars)).toBe("{{missing}}")
})

test("jpegSize reads frame dimensions", () => {
  const sof = (height: number, width: number) => Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0xff, 0xd9,
  ])
  expect(jpegSize(sof(1280, 889))).toEqual({ width: 889, height: 1280 })
  expect(jpegSize(sof(1824, 1280))).toEqual({ width: 1280, height: 1824 })
})

test("modalWidth picks the most common width", () => {
  expect(modalWidth([{ width: 898 }, { width: 889 }, { width: 889 }])).toBe(889)
  expect(() => modalWidth([])).toThrow()
})

test("pool runs at most `limit` workers and processes every item", async () => {
  let running = 0
  let peak = 0
  const done: number[] = []
  await pool(3, [1, 2, 3, 4, 5, 6], async (item) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 10))
    done.push(item)
    running--
  })
  expect(peak).toBe(3)
  expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  await pool(5, [1, 2], async () => {})
  await pool(3, [], async () => {})
})

test("jobQueue wakes every consumer and drains producers before closing", async () => {
  const queue = jobQueue<number>()
  const seen: number[] = []
  const workers = [1, 2, 3].map(() => (async () => {
    for (;;) {
      const item = await queue.next()
      if (item === undefined) return
      seen.push(item)
    }
  })())
  for (const item of [1, 2, 3, 4, 5]) queue.push(item)
  queue.close()
  await Promise.all(workers)
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  expect(await queue.next()).toBeUndefined()
  expect(() => queue.push(6)).toThrow()
})

test("typesettingDefaults accepts the full translation patch", () => {
  const value = typesettingDefaults({
    en: {
      direction: "horizontal",
      language: "en",
      style: {
        chars: { family: "Noto Sans", weight: 600, italic: false, size: 34, fill: [0, 0, 0, 1], stroke: [1, 1, 1, 1], stroke_width: 2 },
        align: "center",
        line_height: 1.2,
      },
      frame: { box: { fit: "best", anchor: "center" } },
    },
  })
  expect(value.en).toEqual({
    direction: "horizontal",
    language: "en",
    style: {
      chars: { family: "Noto Sans", weight: 600, italic: false, size: 34, fill: [0, 0, 0, 1], stroke: [1, 1, 1, 1], stroke_width: 2 },
      align: "center",
      line_height: 1.2,
    },
    frame: { box: { fit: "best", anchor: "center" } },
  })
  expect(typesettingDefaults(undefined)).toEqual({})
  expect(typesettingDefaults({ en: {} })).toEqual({ en: {} })
})

test("typesettingDefaults names every rejected field", () => {
  expect(() => typesettingDefaults({ eng: {} })).toThrow(/2-letter/)
  expect(() => typesettingDefaults({ en: { content: "x" } })).toThrow(/per block/)
  expect(() => typesettingDefaults({ en: { transform: [[1, 0, 0]] } })).toThrow(/per block/)
  expect(() => typesettingDefaults({ en: { direction: "diagonal" } })).toThrow(/direction must be one of/)
  expect(() => typesettingDefaults({ en: { style: { size: 20 } } })).toThrow(/not a style field/)
  expect(() => typesettingDefaults({ en: { style: { chars: { colour: [0, 0, 0, 1] } } } })).toThrow(/not a character field/)
  expect(() => typesettingDefaults({ en: { style: { chars: { weight: 0 } } } })).toThrow(/weight/)
  expect(() => typesettingDefaults({ en: { style: { chars: { size: -1 } } } })).toThrow(/size/)
  expect(() => typesettingDefaults({ en: { style: { chars: { fill: [0, 0, 0] } } } })).toThrow(/four numbers/)
  expect(() => typesettingDefaults({ en: { style: { align: "middle" } } })).toThrow(/align must be one of/)
  expect(() => typesettingDefaults({ en: { style: { line_height: 0 } } })).toThrow(/line_height/)
  expect(() => typesettingDefaults({ en: { frame: { bounds: { x: 0 } } } })).toThrow(/per block/)
  expect(() => typesettingDefaults({ en: { frame: { box: { bounds: { x: 0 } } } } })).toThrow(/per block/)
  expect(() => typesettingDefaults({ en: { frame: { box: { fit: "stretch" } } } })).toThrow(/fit must be one of/)
  expect(() => typesettingDefaults({ en: { frame: { box: { anchor: "top" } } } })).toThrow(/anchor must be one of/)
})

test("typesettingOps applies frame only to box frames", () => {
  const items = blocks({ layers: [
    block("box", "a", "A", { frame: { box: { bounds: { x: 1, y: 2, width: 3, height: 4 } } } }),
    block("point", "b", "B"),
  ] })
  const ops = typesettingOps(items, { direction: "horizontal", style: { align: "center" }, frame: { box: { fit: "best" } }, language: "en" })
  expect(ops).toEqual([
    { op: "update_layer", layer: "box", patch: { translation: { direction: "horizontal", style: { align: "center" }, language: "en", frame: { box: { fit: "best" } } } } },
    { op: "update_layer", layer: "point", patch: { translation: { direction: "horizontal", style: { align: "center" }, language: "en" } } },
  ])
  expect(typesettingOps(items, {})).toEqual([])
})

test("pageBudget scales with blocks and caps at twice the base", () => {
  expect(pageBudget(8, 0)).toBe(8)
  expect(pageBudget(8, 1)).toBe(8.25)
  expect(pageBudget(8, 17)).toBe(12.25)
  expect(pageBudget(8, 40)).toBe(16)
  expect(pageBudget(12, 40)).toBe(22)
  expect(pageBudget(12, 80)).toBe(24)
  expect(() => pageBudget(0, 5)).toThrow()
  expect(() => pageBudget(8, -1)).toThrow()
})

test("needsFollowup gates on edits, with or without rules", () => {
  expect(needsFollowup("RULES", 3)).toBe(true)
  expect(needsFollowup("RULES", 0)).toBe(false)
  expect(needsFollowup("", 3)).toBe(true)
  expect(needsFollowup("", 0)).toBe(false)
})

test("resolveLabels maps bN to real ids and rejects unknown labels", () => {
  const byLabel = new Map([["b1", "uuid-1"], ["b3", "uuid-3"]])
  expect(resolveLabels([
    { op: "set_text", layer: "b3", text: "SQUELCH" },
    { op: "update_layer", layer: "uuid-1", patch: { translation: {} } },
    { op: "transform_layer", layer: "$local", transform: [[1, 0, 1], [0, 1, 1]] },
  ], byLabel)).toEqual([
    { op: "set_text", layer: "uuid-3", text: "SQUELCH" },
    { op: "update_layer", layer: "uuid-1", patch: { translation: {} } },
    { op: "transform_layer", layer: "$local", transform: [[1, 0, 1], [0, 1, 1]] },
  ])
  expect(() => resolveLabels([{ op: "set_text", layer: "b9", text: "x" }], byLabel)).toThrow(/Unknown block label b9/)
})

test("coverBlockOps creates a top-level text block with no mask", () => {
  expect(coverBlockOps("page-1", { text: "TITLE WORD", box: { x: 1, y: 2, width: 3, height: 4 } })).toEqual([{
    op: "add_layer", page: "page-1", index: 0,
    layer: { kind: "block", role: "text", source: { content: [{ insert: "TITLE WORD" }], frame: { box: { bounds: { x: 1, y: 2, width: 3, height: 4 } } } } },
  }])
  expect(JSON.stringify(coverBlockOps("page-1", { text: "T", box: { x: 0, y: 0, width: 1, height: 1 } }))).not.toContain("mask")
})

test("pdfInfo reads page count, size and page dimensions", () => {
  expect(pdfInfo("Pages:           5\nPage size:      595 x 842 pts (A4)\nFile size:      12345 bytes")).toEqual({ pages: 5, pageSize: "595 x 842 pts (A4)", fileSize: 12345 })
  expect(pdfInfo("no pdf info")).toEqual({})
})

test("ocrWords and coverBox read tesseract TSV with a low threshold", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t10\t20\t100\t30\t92.5\tTITLE",
    "5\t1\t1\t1\t1\t2\t120\t20\t80\t30\t11.2\tWORD",
    "5\t1\t1\t1\t1\t3\t210\t20\t80\t30\t4.1\tskip",
  ].join("\n")
  const words = ocrWords(tsv, 10)
  expect(words.map((word) => word.text)).toEqual(["TITLE", "WORD"])
  expect(coverBox(words)).toEqual({ text: "TITLE WORD", box: { x: 10, y: 20, width: 190, height: 30 } })
  expect(coverBox(words, 1000)).toEqual({ text: "TITLE WORD", box: { x: 10, y: 20, width: 190, height: 30 } })
  expect(coverBox(words, 60)).toBeUndefined()
  expect(coverBox(words.slice(0, 1))).toBeUndefined()
  expect(coverBox([])).toBeUndefined()
})

test("coverBox rejects OCR noise with digits and currency symbols", () => {
  expect(coverBox(ocrRow(["va", "¥", "R", "//19"]), 1000)).toBeUndefined()
  expect(coverBox(ocrRow(["va", "¥", "R", "//19"]))).toBeUndefined()
  expect(coverBox(ocrRow(["page", "12"]), 1000)).toBeUndefined()
})

test("coverBox accepts an alphabetic title with hearts and apostrophes", () => {
  expect(coverBox(ocrRow(["Burnice", "x", "Piper"]), 1000)).toEqual({
    text: "Burnice x Piper",
    box: { x: 10, y: 20, width: 280, height: 30 },
  })
  expect(coverBox(ocrRow(["Burnice-chan", "Piper♡"]), 1000)).toEqual({
    text: "Burnice-chan Piper♡",
    box: { x: 10, y: 20, width: 180, height: 30 },
  })
})

test("cjk and duplicateFrames audit a page", () => {
  expect(cjk("Mm♡")).toBe(false)
  expect(cjk("まだ")).toBe(true)
  const page = { layers: [
    block("a", "原", "A", { frame: { box: { bounds: { x: 1, y: 2, width: 3, height: 4 } } } }),
    block("b", "文", "文", { frame: { box: { bounds: { x: 1, y: 2, width: 3, height: 4 } } } }),
  ] }
  expect(duplicateFrames(page)).toEqual([{ frame: { x: 1, y: 2, width: 3, height: 4 }, labels: ["a", "b"] }])
})
