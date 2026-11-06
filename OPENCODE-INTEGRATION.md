# Nexus + OpenCode integration — work in progress

## Goal

Keep the existing Nexus Electron UI, workspace handling, model pool and multi-agent workflow. Run the actual OpenCode harness **in-process**, without an OpenCode server, and use **LM Studio on this computer** as the only model backend. The integration is not yet implemented; Nexus still uses its original `core/agent.js` and `core/orchestrator.js`.

## Source reference

`vendor/opencode-v1.19.5-reference.tar.gz` contains an unmodified, partial source snapshot of OpenCode v1.19.5, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c` from <https://github.com/anomalyco/opencode>. It contains the `packages/opencode/src`, `packages/core/src`, and `packages/plugin/src` trees, their package manifests, root configuration/lockfile, and the upstream MIT license. It is a **reference snapshot**, not a complete buildable checkout and not an integrated runtime. Obtain the complete pinned source with:

```sh
git clone https://github.com/anomalyco/opencode.git
git -C opencode checkout 810c0eba1a7348036f8bdf61e6632d0c36c6876c
```

SHA-256 of the reference archive: `de907874d9636d2de70f22eed7836d1c270a2896c4c54ade100f6750bfa7e2e2`.

## Verified architectural boundaries

- `packages/opencode/src/session/prompt.ts` and `session/processor.ts`: prompt and agent/tool loop; sessions, tool execution, retry and compaction interact with multiple services.
- `packages/opencode/src/tool/`, `permission/`, `question/`, `agent/`, `mcp/`, `skill/`, `lsp/`, `plugin/` and `config/`: OpenCode's built-in capability and policy implementations.
- `packages/core/src/`: shared effect services and database dependencies. OpenCode's root package specifies Bun and workspace dependencies. Nexus currently uses Electron/Node with CommonJS. Compatibility, packaging and service initialization therefore need real engineering rather than copying a prompt or reimplementing a few tool names.
- Nexus already has its own LM Studio model pool, router and orchestrator in `core/`. These need a carefully defined adapter so OpenCode subagent calls use Nexus-selected local models while preserving pool leases and user-facing events.

## Completed

- Preserved the original Nexus chat path; no incomplete replacement has been connected to the UI.
- Restricted the existing Nexus LM Studio client to loopback HTTP(S) endpoints and disallowed HTTP redirects on model requests. Automated tests cover the URL policy and request option.
- Saved the version-matched upstream source reference with its license.
- Tested the existing Nexus agent, model pool and a file-writing tool with an empty home directory and a simulated LM Studio API; no OpenCode executable or configuration was present in the test. This does not test the desktop UI or a real local model.
- Enforced the configured GPU resident limit for Nexus model leases, with waiting for active agents and explicit unload-error handling. Added tests for concurrent leases and swaps.
- Fixed supervisor error propagation so a failed specialist stops dependent steps rather than being treated as successful; tested planner → specialists → synthesis using mocked model replies.
- Made the existing shell tool select Windows or POSIX shell based on platform.

## Still required

1. Build and package the pinned upstream runtime and its workspace dependencies for Electron; prove that the OpenCode session services run in-process without `opencode serve` or a server subprocess.
2. Wire OpenCode's actual model/provider interface to LM Studio and Nexus's load/lease/eviction lifecycle. Ensure every model inference route, including plugins and subagents, enforces local-only transport. The existing Nexus client restriction does **not** apply to a future OpenCode provider automatically.
3. Translate real OpenCode session, permission, question, streaming, tool and subagent events into Nexus IPC/UI, including replies and cancellation. Preserve conversation persistence and Nexus's existing controls.
4. Preserve upstream behavior for tools, MCP, skills, LSP, plugins, instructions, permissions and sessions; map Nexus model selection and supervisor dispatch without silently weakening policies.
5. Test with an actual LM Studio server and multiple local models, plus mocked models and integration tests for session continuation, permission denials, subagent routing, tool calls and network restrictions. Test desktop packaging on the target OS.

## Safety and scope

The loopback restriction covers **only the current Nexus LM Studio client**. Shell commands, MCP servers, web tools and plugins may access networks or the host and are not sandboxed by this restriction. The original SYSTEM toggle and workspace path checks should not be treated as an OS-level security sandbox: shell commands and symlinks can bypass path confinement. Do not claim complete OpenCode parity or cloud-free behavior for the future integrated harness until the provider and plugin/subagent paths have been audited and tested.
