<div align="center">

# opencode-koharu

**OpenCode config, agents, and plugins that translate and typeset manga with Koharu.**

</div>

<hr>

<div align="center">
● <a href="#installation">Installation</a> ﻿ ● <a href="#setup">Setup</a> ﻿ ● <a href="#usage">Usage</a> ﻿ ● <a href="#layout">Layout</a><br>
● <a href="#guild-use">Guild use</a> ﻿ ● <a href="#docs">Docs</a> ﻿ ● <a href="#license">License</a>
</div>

## Installation

Clone the repo, then install the dependencies for the plugin and the glossary MCP (Model Context Protocol) server:

```bash
git clone https://github.com/FAZuH/opencode-koharu.git
cd opencode-koharu
(cd .opencode/plugins/manga-dispatch && bun install)
(cd tools/glossary-mcp && bun install)
```

## Setup

Two external tools are needed before you translate a gallery:

- **Koharu `serve`**: the MCP server that holds one open project. `bin/serve.sh` starts and stops it. It uses the `serve` binary on `PATH`, or the binary named by `KOHARU_SERVE_BIN`. Install it from an upstream Koharu source checkout:
  ```bash
  cargo install --path crates/koharu-agent --example serve --root ~/.local
  ```
  On a GPU-less host, `bin/serve.sh` already sets `GGML_VK_VISIBLE_DEVICES=0`. See [Inference on a GPU-less host](docs/llvmpipe-inference.md) for the reason.
- **`gallery-dl`**: must be on `PATH` when the `manga-master` agent downloads a gallery.

Run OpenCode from the repo root, or copy `.opencode/` into the workspace that should use it. OpenCode reads `.opencode/opencode.json`, which loads the plugin and registers the `koharu` and `glossary` MCP servers.

## Usage

Start the server for an existing project, then ask `manga-master` to translate a gallery:

```bash
bin/serve.sh manga/<gallery>/project.khr
```

```
Translate this gallery into English as <work name>: <gallery url>
```

`manga-master` prepares the gallery, translates each page in an isolated session, typesets it, and builds the PDF. Output lands under `$XDG_DATA_HOME/opencode-koharu/manga/<slug>/translated/`. The `manga_prepare` tool can create the project from a gallery URL, so no project needs to be open first.

## Layout

- `.opencode/plugins/manga-dispatch/`: plugin providing `manga_prepare`, `manga_translate`, `manga_submit`, `manga_typeset`, `manga_view`, `manga_audit`, `manga_prune`, and glossary tools.
- `.opencode/agents/`: `manga-master`, `manga-translator`, and `manga-typesetter` definitions.
- `tools/glossary-mcp/`: Bun MCP server for per-project translation memory.
- `bin/serve.sh`: starts or stops the Koharu MCP server (`bin/serve.sh --stop [port]`).
- `.opencode/opencode.json`: plugin and MCP config for the workspace.

Runtime data is independent of the working directory:

- Projects, sources, and translated PDFs: `$XDG_DATA_HOME/opencode-koharu/manga/` (default `~/.local/share/opencode-koharu/manga/`).
- Koharu MCP server: `http://127.0.0.1:7878/mcp`, bound to localhost only.
- Logs: `$XDG_DATA_HOME/opencode-koharu/logs/`.

The `manga-master` agent allows only `gallery-dl*` shell commands and no absolute path under a home directory.

## Guild use

For a Discord guild, install the plugin and agent definitions under that session's `.opencode/` directory. MCP servers stay in the parent session config.

## Docs

### User guides

- [Manga dispatch plugin](.opencode/plugins/manga-dispatch/README.md): tools, options, command hooks, typesetting rules, PDF output, and run journal.
- [Inference on a GPU-less host](docs/llvmpipe-inference.md): why `serve` needs `GGML_VK_VISIBLE_DEVICES=0` on llvmpipe, with verification evidence.

## License

No license file is present in this repository.
