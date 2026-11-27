import { Database } from "bun:sqlite"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const path = process.env.GLOSSARY_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "koharu-glossary", "glossary.sqlite")
mkdirSync(dirname(path), { recursive: true })
const db = new Database(path, { create: true })
db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL")
db.exec(`CREATE TABLE IF NOT EXISTS entries (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  translation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('name', 'place', 'term')),
  note TEXT,
  PRIMARY KEY (project, id),
  UNIQUE (project, source)
)`)

const required = z.string().trim().min(1).max(4096)
const project = z.string().trim().min(1).max(512)
const kind = z.enum(["name", "place", "term"])
const server = new McpServer({ name: "koharu-project-glossary", version: "1.0.0" })
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })
const read = (p: string, id: string) => db.query("SELECT id, source, translation, kind, note FROM entries WHERE project = ? AND id = ?").get(p, id)
const readBySource = (p: string, source: string) => db.query("SELECT id, source, translation, kind, note FROM entries WHERE project = ? AND source = ?").get(p, source)

server.registerTool("list", {
  description: "List glossary entries belonging to the supplied project identifier.",
  inputSchema: { project },
}, async ({ project }) => output({ entries: db.query("SELECT id, source, translation, kind, note FROM entries WHERE project = ? ORDER BY source").all(project) }))

server.registerTool("add", {
  description: "Add or update a glossary entry in one project. Re-adding an existing source updates its translation and kind, and replaces its note only when one is supplied.",
  inputSchema: { project, source: required, translation: required, kind, note: z.string().max(4096).optional() },
}, async ({ project, source, translation, kind, note }) => {
  const id = crypto.randomUUID()
  db.query(`INSERT INTO entries(project,id,source,translation,kind,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(project, source) DO UPDATE SET translation = excluded.translation, kind = excluded.kind, note = COALESCE(excluded.note, entries.note)`).run(project, id, source, translation, kind, note ?? null)
  return output({ entry: readBySource(project, source) })
})

server.registerTool("update", {
  description: "Update an entry within the supplied project. Supply at least one changed field.",
  inputSchema: { project, id: required, source: required.optional(), translation: required.optional(), kind: kind.optional(), note: z.string().max(4096).nullable().optional() },
}, async ({ project, id, ...fields }) => {
  const changes = Object.entries(fields).filter(([, value]) => value !== undefined)
  if (!changes.length) throw new Error("Provide at least one field to update")
  const statement = `UPDATE entries SET ${changes.map(([key]) => `${key} = ?`).join(", ")} WHERE project = ? AND id = ?`
  const result = db.query(statement).run(...changes.map(([, value]) => value), project, id)
  if (!result.changes) throw new Error("Entry not found in project")
  return output({ entry: read(project, id) })
})

server.registerTool("remove", {
  description: "Remove an entry from the supplied project by ID.",
  inputSchema: { project, id: required },
}, async ({ project, id }) => {
  const result = db.query("DELETE FROM entries WHERE project = ? AND id = ?").run(project, id)
  if (!result.changes) throw new Error("Entry not found in project")
  return output({ removed: true, id })
})

await server.connect(new StdioServerTransport())
