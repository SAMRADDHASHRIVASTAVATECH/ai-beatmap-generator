# Nexus — local agent harness (repo: `ai-beatmap-generator`)

## Standalone status

Nexus does **not** need the OpenCode executable or an OpenCode server to run its existing agent. OpenCode configuration and skills are optional inputs. The TUI needs Node.js, a real terminal, and LM Studio with compatible local models. Only the legacy GUI additionally needs Electron dependencies and a desktop session. Run `npm install`, then `npm start`; run `npm test` for automated checks. The standalone agent test uses a mock LM Studio server, not a real model.

**The actual OpenCode harness is not yet integrated.** The included upstream archive is a source reference, not a working implementation. See `OPENCODE-INTEGRATION.md` and `NEXUS-STATUS.md` for the remaining work and test evidence.

Nexus discovers additional LM Studio models by exact ID. Their capabilities are unknown until independently measured; selecting a model does not establish that it supports tool calls. Conversations are saved locally per workspace in the Electron user-data directory, as plaintext JSON, and recent complete turns are sent to the local model. Sensitive agent actions require per-action approval, but shell commands and MCP servers are not sandboxed.

> **Heads-up:** the repository is named `ai-beatmap-generator`, but the code in it is
> **not** a beatmap generator. It is **Nexus**, a local coding-agent harness
> powered by **LM Studio**, with a TUI and optional Electron GUI. There is no
> osu!/beatmap code anywhere in the tree (verified with a full-text search).

## What it actually is

Nexus is a local agent harness for running local LLMs as coding agents (terminal UI by default, with an optional Electron GUI):

- **Model pool** (`core/pool.js`) — loads/unloads LM Studio models, keeps only one
  model resident at a time (designed for a 4 GB GPU), with a 15-minute idle TTL.
- **Model registry** (`core/config.js`, `core/inventory.js`) — named profiles matched against LM Studio model keys plus newly discovered exact model IDs. Capabilities of untested models remain unknown.
- **Router** (`core/router.js`) — cheap keyword heuristics pick a profile per turn.
- **Agent loop** (`core/agent.js`) — tool-calling loop with a system prompt, todo list,
  subagents, and a 40-tool cap for native MCP tools.
- **Supervisor/orchestrator** (`core/orchestrator.js`) — a planner model writes a plan,
  then dispatches steps to specialist agents and synthesises the result.
- **Tools** (`core/tools.js`) — read/write/edit/patch files, grep/glob/list, run shell
  commands, web fetch, open paths, system info, MCP catalog/inspect/call, skills.
- **Capability inheritance** (`core/inherit.js`) — reads the machine's OpenCode config
  (`~/.config/opencode/opencode.jsonc`) and inherits its MCP servers and skills.
- **TUI** (`core/tui-lib.js`, `core/tui-runtime.js`) — responsive terminal chat, animated presence, command search, approvals and saved sessions.
- **Legacy GUI** (`renderer/`) — Electron chat, workspace picker, model pool and MCP panels.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js + npm | TUI has no runtime packages; Electron is only needed for `npm run gui` |
| **LM Studio** running locally | Defaults to `http://127.0.0.1:1234` (override with `LMSTUDIO_BASE`) |
| Local models installed in LM Studio | Registry expects keys such as `qwen3-4b-instruct-2507`, `qwen3.5-2b`, `ministral-3-3b-instruct-2512`, `lfm3-vl-2b`, `rnj-1-instruct`, `nomic-embed-text` |
| A GPU (ideally ~4 GB+ VRAM) | The pool is tuned for one resident model; CPU offload works but is slow |
| A terminal | `npm start` needs an interactive TTY; only the Electron GUI needs a desktop session |

Optional: [OpenCode](https://github.com/anomalyco/opencode) config at
`~/.config/opencode/` to inherit MCP servers and skills.

## Daily interface: the `nexus` TUI

The primary interface is a keyboard-first, full-screen terminal UI. It retains the
NEXUS deep-navy / steel-blue / ivory identity, but the interface has been rewritten
as a compact single-column conversation. The editor and footer stay visible even
on smaller terminals; menus take over the conversation area rather than pushing the
composer off-screen. A subtle idle pulse, working spinner, moving progress rail and
live tool activity animate while the agent works. Only changed terminal rows repaint.

```bash
npm start                        # interactive TUI (from this repository)
node tui.js                       # same without npm
nexus "What is this project?"    # one-shot mode, after npm link
nexus gui                         # optional legacy Electron UI
```

| Action | Keys / command |
| --- | --- |
| Send / new line | Enter / Shift+Enter |
| Command search | Ctrl+P or `/help`; type to filter, arrows + Enter to select |
| Conversations | Ctrl+N new, `/chats` browse; R rename, P pin, D delete |
| Workspace file context | Type `@path/to/file` or `/attach` to search and select text files |
| Local shell | Prefix your message with `!`, e.g. `!git status` |
| Agent routing | Tab cycles auto → supervisor → direct; `/model <profile>` pins a direct-run model |
| Stop / pause | Ctrl+X or Esc stops the active run; `/halt` pauses future runs, `/unhalt` resumes |
| SYSTEM access | Ctrl+S twice within 3 seconds to arm; Ctrl+S once to disarm |
| Scroll / draft | PgUp/PgDn transcript; Up/Down message history; Ctrl+U clears draft |
| Reduce motion | `/motion` toggles it, or launch with `NEXUS_NO_ANIMATION=1` |
| Voice (optional) | Ctrl+M records/transcribes if ffmpeg + Python `faster-whisper` are installed |
| Quit | Ctrl+C |

`/mcp`, `/skill`, `/duplicate`, `/clear`, `/undo`, `/compact`, `/export`,
`/thinking`, `/mode` and `/ws` are also available in command search. `/ws` shows
the current workspace; to change it, restart with `NEXUS_WORKSPACE=<path>`.
Use `NO_COLOR=1` for plain text. The TUI requires a TTY; one-shot mode works in pipes.
Conversation history is saved as plaintext JSON under `~/.config/opencode/chats/`
(override the root with `NEXUS_DATA_DIR`).

**Safety:** TUI SYSTEM access starts **off**. This is an advisory path policy,
not an OS sandbox: `!cmd` runs a local shell, and MCP servers may access other
paths or networks. One-shot mode retains its existing trusted-operator behavior
(auto-approves actions and enables SYSTEM), so only use it with prompts you trust.

## Run it

```bash
npm install
npm start          # = nexus TUI (no Electron needed)
npm link           # optional: install the global `nexus` command for this checkout
nexus "fix the bug"  # one-shot agent run, OpenCode `opencode run` style
npm run gui        # legacy Electron UI
npm test           # automated checks
```

In the TUI, work is scoped to the current directory or `NEXUS_WORKSPACE`. Start
LM Studio's local server (Developer tab) before sending agent prompts. Offline
mode still lets you browse saved chats, edit drafts and use explicit `!cmd` shell
commands. For the legacy Electron GUI, use its workspace picker and model pool.

## Caveats found while cloning

- **No README, no license, no tests** in the original repo — this file and the local model endpoint tests are new.
- The requested actual OpenCode in-process harness integration is **not complete**. See `OPENCODE-INTEGRATION.md` for the source reference and status.
- Model requests are restricted to a loopback LM Studio endpoint; this does not restrict network access by shell commands or MCP tools.
- The repo name is misleading (see above).
- Committed debug artefacts (`_drive*.js`, `*.log`, `_e2e.js`, `_probe.js`) contain
  machine-specific paths and MCP server names; they are not needed to run the app.
- `systemAccess` is a real capability switch: when ON, the agent can run commands
  outside the workspace and open paths/apps on the host machine.
- The app is built around a 4 GB VRAM budget; on larger GPUs you may want to raise
  `max_resident` in `core/config.js`.
- The model keys in `core/config.js` must match what your LM Studio install exposes;
  otherwise the pool will report models as unavailable.

## Layout

```
main.js            Electron main process + IPC
preload.js         contextBridge API (window.nexus)
core/config.js     model registry + policy
core/lmstudio.js   LM Studio REST client
core/pool.js       resident-model pool / VRAM reaper
core/router.js     per-turn model routing
core/agent.js      single-agent tool loop
core/orchestrator.js  supervisor: plan -> dispatch -> synthesise
core/inherit.js    OpenCode MCP + skill inheritance
core/mcp.js        MCP client (stdio)
core/tools.js      tool schemas + execution
renderer/          index.html, app.js, styles.css
```
