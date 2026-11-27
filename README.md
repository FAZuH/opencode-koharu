# opencode-koharu

OpenCode config and plugins for translating manga with Koharu. The setup is
independent of the working directory: runtime data lives under
`$XDG_DATA_HOME/opencode-koharu/` (default `~/.local/share/opencode-koharu/`).

## Layout

- `.opencode/plugins/manga-dispatch/` plugin providing `manga_prepare`,
  `manga_translate`, `manga_submit`, `manga_typeset`, and glossary tools.
- `.opencode/agents/` the `manga-master`, `manga-translator`, and
  `manga-typesetter` definitions.
- `tools/glossary-mcp/` Bun MCP server for per-project translation memory.
- `bin/serve.sh` starts or stops the Koharu MCP server.
- `.opencode/opencode.json` plugin and MCP config for this workspace.

## Runtime

- Manga projects, sources, and translated PDFs:
  `$XDG_DATA_HOME/opencode-koharu/manga/`.
- Koharu MCP server: `http://127.0.0.1:7878/mcp`, bound to localhost only.
  Start it with `bin/serve.sh <project.khr>`.
- `gallery-dl` must be available on `PATH` for the user running the agent. The
  `manga-master` agent allows `gallery-dl*` shell commands and no absolute
  path under a home directory.

## Guild use

For a Discord guild, install the plugin and agent definitions under that
session's `.opencode/` directory. MCP servers stay in the parent session
config.
