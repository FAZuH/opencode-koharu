import { test, expect } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("MCP CRUD isolates projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glossary-mcp-"))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.ts"],
    env: { ...process.env, GLOSSARY_DB: join(dir, "test.sqlite") },
    cwd: process.cwd(),
  })
  const client = new Client({ name: "test", version: "1.0.0" })
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  const value = (result: any) => JSON.parse(result.content[0].text)
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["add", "list", "remove", "update"])
    const added = value(await call("add", { project: "project-a", source: "名前", translation: "Name", kind: "name" }))
    const id = added.entry.id
    expect(value(await call("list", { project: "project-a" })).entries).toHaveLength(1)
    expect(value(await call("list", { project: "project-b" })).entries).toHaveLength(0)
    const duplicateResult = await call("add", { project: "project-a", source: "名前", translation: "Duplicate", kind: "term", note: "checked" })
    expect(duplicateResult.isError).toBeUndefined()
    const duplicate = value(duplicateResult)
    expect(duplicate.entry.id).toBe(id)
    expect(duplicate.entry).toEqual({ id, source: "名前", translation: "Duplicate", kind: "term", note: "checked" })
    expect(value(await call("list", { project: "project-a" })).entries).toEqual([duplicate.entry])
    const other = value(await call("add", { project: "project-b", source: "名前", translation: "Other", kind: "name" }))
    expect((await call("update", { project: "project-b", id, translation: "Wrong" })).isError).toBe(true)
    expect((await call("remove", { project: "project-b", id })).isError).toBe(true)
    expect(value(await call("update", { project: "project-a", id, translation: "New name" })).entry.translation).toBe("New name")
    expect((await call("update", { project: "project-a", id })).isError).toBe(true)
    expect(value(await call("remove", { project: "project-a", id })).removed).toBe(true)
    expect(value(await call("list", { project: "project-a" })).entries).toHaveLength(0)
    expect(value(await call("list", { project: "project-b" })).entries[0].id).toBe(other.entry.id)
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("add preserves an existing note unless a new one is supplied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glossary-mcp-"))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.ts"],
    env: { ...process.env, GLOSSARY_DB: join(dir, "test.sqlite") },
    cwd: process.cwd(),
  })
  const client = new Client({ name: "test", version: "1.0.0" })
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  const value = (result: any) => JSON.parse(result.content[0].text)
  try {
    await client.connect(transport)
    const args = { project: "project-note", source: "バーニス", translation: "Burnice", kind: "name" }
    const id = value(await call("add", { ...args, note: "character" })).entry.id
    const withoutNote = value(await call("add", args))
    expect(withoutNote.entry.note).toBe("character")
    expect(withoutNote.entry.id).toBe(id)
    const withNewNote = value(await call("add", { ...args, note: "playable character" }))
    expect(withNewNote.entry.note).toBe("playable character")
    expect(value(await call("list", { project: "project-note" })).entries).toEqual([withNewNote.entry])
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("entries survive a server restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glossary-mcp-"))
  const connect = async () => {
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.ts"],
      env: { ...process.env, GLOSSARY_DB: join(dir, "test.sqlite") },
      cwd: process.cwd(),
    }))
    return client
  }
  try {
    const first = await connect()
    await first.callTool({ name: "add", arguments: { project: "p", source: "源", translation: "source", kind: "term" } })
    await first.close()
    const second = await connect()
    const result = await second.callTool({ name: "list", arguments: { project: "p" } })
    expect(JSON.parse((result.content as any[])[0].text).entries[0].translation).toBe("source")
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
