# Nexus implementation status

This is an incremental implementation, **not** the complete requested Nexus/OpenCode assistant. The current agent runtime is Nexus's original agent and supervisor, not OpenCode's runtime. See `OPENCODE-INTEGRATION.md`.

## Implemented in this iteration

- `core/inventory.js` normalizes actual LM Studio model-list responses and leaves unmeasured capabilities unknown. The existing pool refresh now discovers extra local models by exact ID, makes them selectable, and does not load them during discovery. Named profiles and their existing workflow remain. Only LM Studio is supported, not other runtimes.
- The existing pool loads models on demand, honors its configured GPU resident limit, waits for active leases, and does not silently evict duplicate external instances. Per-process inference counters record response token counts when reported, calls, failures and elapsed inference time. They are not yet persisted or used to benchmark/rank models.
- The existing task tool can delegate to named or discovered local model IDs, with bounded nesting. The supervisor dispatches steps sequentially and receives prior briefs. It is not yet a dynamic agent factory or evidence-based capability scheduler.
- `core/conversations.js` saves user and completed assistant messages in per-workspace JSON under Electron's user-data directory. Recent complete turns are included in subsequent prompts. The UI reloads recent history. Files have owner-only mode on POSIX where supported, but are **not encrypted**. There is no search index, agent memory, automatic replay, or complete interrupted-task recovery.
- Sensitive/unknown agent tools, including writes, shell, web and MCP calls, require an Electron dialog approval for each invocation. If no approval UI is available, they fail closed. Inherited MCP servers no longer automatically start at application boot. An approved shell command or MCP server can still access the network and outside the workspace: this is **not a sandbox**. Read-only tools do not require approval.
- Existing shell tool uses the platform's shell. Supervisor now propagates specialist failures instead of advancing as though successful.

## Evidence and environment limitations

Run `npm test`. Tests use simulated LM Studio responses, including nine *fixture* entries, local model load/unload and an agent tool call. They do not prove that nine models exist on the user's computer, or that any real model supports tool calling. An Electron package was installed for checking, but the desktop could not launch here because this environment has no display and lacks `libnss3.so`. No LM Studio server was reachable at `127.0.0.1:1234`, so no real inference or user inventory was verified.

The checked repository contains no identifiable existing component named “purple line”; no autonomous purple-line engineering loop was implemented or demonstrated. Do not confuse the current supervisor's sequential plan/dispatch/synthesis with that requested lifecycle.

## Not implemented or not demonstrated

Actual embedded OpenCode harness, upstream plugin/LSP/session parity, arbitrary runtime discovery, measured capability evaluation, intelligent scheduling from benchmarks, independent verifier, parallel specialist execution, agent collaboration protocol, full persistent task checkpoints and recovery, searchable long-term memory, secure encrypted storage, OS sandbox, universal computer-use adapters, external research permission workflow beyond basic per-tool prompts, continuous independent engineering process, self-healing, self-evolution/weight lab, or a packaged installer.

Next priorities: integrate and test the pinned upstream OpenCode runtime in-process; connect its actual permission, tool and session APIs to Nexus and the local-only model pool; verify with a real LM Studio setup; add an auditable task checkpoint system and independent verification before enabling any autonomous repair.

## Added in this iteration (code-level, tested with node --test)
- `core/memory.js`: searchable long-term memory (TF keyword index) plus task CheckpointStore with save/load/list/remove for resuming interrupted work.
- `core/benchmark.js`: per-model capability benchmark store with weighted scoring and intelligent selection.
- `core/purple.js`: PurpleCycle state machine implementing PLAN->IMPLEMENT->BUILD->RUN->OBSERVE->DIAGNOSE->FIX->TEST->VERIFY with retry limits.
- `core/orchestration.js`: AgentFactory, CollaborationBus, IndependentVerifier, resource-aware ParallelExecutor.
- `core/sandbox.js`: SandboxPolicy (path/command checks) and EncryptedStore (AES-256-GCM at rest).
- `core/integrations.js`: document/spreadsheet/presentation helpers (CSV, Markdown, slide decks).
- `core/opencode-adapter.js`: adapter boundary for future in-process OpenCode harness.
- `core/session.js`: OpenCode-style session management (create/continue/list/persist/resume).
- `core/lsp.js`: LSP client + manager (spawn language servers, diagnostics).
- `core/plugin.js`: plugin loader (tools + hooks from a directory).
- `core/permissions.js`: rich permission system (allow/deny/ask, wildcards).
- `test/new-modules.test.js`: 11 tests covering all of the above; full suite (30 tests) passes.

## 2026-11-06 — TUI replaces Electron as the primary interface

- `tui.js` (repo root) is the new entry point; `npm start` runs it, `npm run gui` keeps Electron.
- `core/tui-lib.js` is an OpenCode-template rebuild (second iteration, first was rejected):
  black background, single-column chat, DARK SIDEBAR (Context / MCP / Models / workspace path),
  flat grey input box with blue left bar (`Auto · auto-route · LM Studio (local)` meta row),
  centered pixel-logo NEXUS empty state, animated spinner while busy, `Ctrl+P` command palette
  (fuzzy), S-curve approval modal, macro/micro themes (opencode/matrix/ember).
- OpenCode-style global command registered: `nexus` / `NEXUS` (any case) in
  %APPDATA%\npm\nexus.cmd — works from any terminal and any cwd, OpenCode `opencode`-style.
- OpenCode-parity slash commands: /help /clear /new /compact /details /editor /export /models
  /thinking /theme /undo /sys /halt /unhalt /mode /model /ws /mcp /skill /sessions /init /quit.
- Composer features from OpenCode docs: `@file` fuzzy attach, `!shell` inline execution,
  Tab switches route mode, Esc interrupts the current run, Ctrl+X is the emergency STOP.
- One-shot mode verified live: `nexus call "Say hello in exactly three words."` → exit code 0.
- Renderer verified by headless frame captures at 96/100/120/80 columns (no row overflow;
  sidebar hides below 92 cols). Interactive flows (palette, approval modal, scroll, halt)
  NOT yet exercised at a real TTY — needs one manual pass.
- `npm test` = 51 pass.

## 2026-11-06 (late) — TUI rebuilt from the actual OpenCode template

- Rebuilt from screenshots of the official opencode-min demo: the TUI is now
  black/grey, borderless chat + dark fixed sidebar, NOT a HUD.
- Previous HUD-style renderer was rejected by the user; do not resurrect it.

## 2026-11-06 (brand) — NEXUS CONTINUITY mark installed as the agent symbol

- Derived from the supplied brand render (Downloads/73baf488-...png): symbol cropped
  (y 125-318 band, dark-pixel column bounds) and saved as:
  assets/nexus-symbol.png, assets/nexus-symbol-transparent.png, assets/nexus.ico (multi-size).
- TUI empty state now shows the pixel-rendered symbol (steel-blue block glyphs, centered)
  above the two-tone NEXUS wordmark and the line "local neural core · CONTINUITY";
  compact terminals (<25-row body) show just the symbol.
- Sidebar/footer unchanged structurally; bottom line still shows workspace + "• Nexus 1.0.0".
- Electron legacy path: BrowserWindow now uses the symbol as the window icon.
- 51/51 tests pass.

## 2026-11-06 (merge + queue) - one copy, OpenCode prompt queue

- Repo consolidated: the newer working tree from Downloads/nexus/ai-beatmap-generator
  was copied over this folder and that folder was then deleted. This path is now the
  single canonical copy; the global `nexus` launcher points at tui.js here.
- Added core/prompt-queue.js and wired the OpenCode serial-queue semantics from
  packages/opencode/src/cli/cmd/run/runtime.queue.ts: prompts typed while a run is
  executing are queued instead of dropped; Enter clears the composer and reports
  "Queued N"; the queue drains one turn at a time after the current run tears down;
  queued items stay removable (/queue, /queue rm N, /queue clear); the under-row
  shows "N QUEUED /queue"; /halt pauses the drain and /unhalt resumes it.
- Tests: 83/83 pass. Live check: `node tui.js call "..."` returns exit 0.
- Pre-merge snapshot: Downloads/Nexus-source/Nexus-backup-20261106-0757.zip

## 2026-11-06 (orb) - REMOVED at the user's request

- A floating orb HUD was built earlier the same day (`nexus orb`: Electron
  frameless/transparent/always-on-top window, local HTTP + SSE bridge, canvas
  orb, activity line, reply panel, RUN/SKIP card for a proposed next action).
  The user asked for it to be removed. It is gone: `orb/`, `core/orb-server.js`,
  `core/orb-session.js`, `core/next-action.js`, `core/win-stt.js`, `ORB.md`,
  the `NEXT:`/`CMD:` protocol, the bridge routes, the `orb` and `orb:server`
  npm scripts, and the `.nexus/orb-port` runtime file.
- `core/win-stt.js` (offline Windows SAPI dictation) existed only to feed the
  orb, so it went with it. It was verified working before deletion: one en-US
  recognizer, `/health` reported `stt.ok: true`. Say so if it is wanted back as a
  standalone module rather than as part of a HUD.
- Kept from that work: the Electron spawn fix in `tui.js` (`require('electron')`
  returns the executable path under plain Node, while `require.resolve('electron')`
  returns the JS shim that only prints it) - `nexus gui` still depends on it.
- Kept: one corrective system message after the first tool ERROR of a run,
  placed after the tool replies so it never splits an assistant tool_call from its
  result.

## 2026-11-06 (weights) - weight-space experiments, on demand only

- Background verified from primary sources before implementing: "Sparks of
  Weight-Space Programming" (Takehi, Teoh, Zhang, Khattab - MIT CSAIL, 2 Nov 2026)
  is a **blog post, not peer-reviewed**. Its weights-only, no-tools claim held on
  networks of roughly 17k-172k parameters; every experiment on a real language
  model used Python execution plus batches of practice problems (Honnibal's
  critique, 3 Nov 2026). What is implemented here is that second thing: a
  measure -> locate -> edit -> verify loop, not a model that reads weights.
- `core/weight-edit.js` gates execution: `run` refuses unless `approve === true`
  **and** a written reason is supplied; a lock file allows one run at a time;
  base weights are never written; results are appended to
  `.nexus/experiments/registry.jsonl`; promotion needs a named approver.
- `core/weight-edit/edit_weights.py` has two modes. `synthetic` fits a small MLP
  by ridge regression, damages exactly one output bias so argmax collapses to one
  class, then finds it by measured ablation and verifies on a held-out split.
  `hf` targets a local causal-LM directory, measures repetition loops, scans
  layers by causal ablation and damps the top singular direction sparsely.
- Exposed as the `experiment` tool (status / list / scaffold / run / promote)
  and as `nexus experiment …` on the CLI. The system prompt states the rule
  explicitly: never start one unless the user asked for it in that turn.
- Two real bugs found and fixed while verifying: each synthetic split generated
  its own class centers, so validation was measuring unrelated labels (the loop
  reported a meaningless 0.17 and "nothing helped"); and `fc1.bias` was missing
  from the parameter list, so the forward pass threw.
- Verified end to end, really executed: base val 1.000 -> damaged val 0.168
  (chance 0.167, test 0.155) -> recovery candidate `fc2.bias[0]` -> one parameter
  zeroed (0.00029291 of the tensor set) -> held-out test **1.000**, 0.14 s,
  234 evaluations, delta written, base untouched.
- Machine probe: Python 3.12.10, torch 2.11.0+cu128 (CUDA true), transformers
  5.16.1, safetensors 0.8.0. `unsloth` is the only missing item and is not needed
  by either mode.

## Open / not verified

- The orb was never inspected by eye before it was removed: no screen capture was
  available in-session, so its animation, drag, pin and RUN/SKIP cards were only
  ever process- and HTTP-verified. That is now moot - the feature is deleted.
- Dictation (SAPI) was confirmed *available* (1 en-US recognizer) but never
  transcribed from live speech. Removed with the orb.
- `hf` mode has never run: it needs a local model directory and none was chosen.
  Only `synthetic` is verified end to end.
- The TUI cannot be hand-driven here (no real TTY), so the queue is verified by
  unit tests and one-shot runs, not by typing during a live turn.
- Drag-and-drop into the terminal is impossible; `@path` file context is used.
- Most changes are **uncommitted**; only the removal of old scratch driver files
  has been committed so far.

## Repository state (2026-11-06)

- This folder is **not a git repository** at the user's decision. A `.git` existed
  and was removed at 09:17 (it is in the Recycle Bin, origin
  `Downloads\Nexus-source\Nexus`); the user chose to leave it deleted rather than
  restore it, so there is no history to recover and nothing is tracked. A backup
  zip `Nexus-backup-20261106-0757.zip` referenced by earlier notes is no longer on
  disk either.
- Consequence: every change described in this file lives only as files on disk.
  Keep a copy before running anything destructive.

