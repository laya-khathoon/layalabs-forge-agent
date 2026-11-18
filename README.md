# Layalabs Forge Agent

A coding agent as a Visual Studio Code extension, whose **agent loop runs on
[TrueForge](https://github.com/truefoundry/trueforge)**, TrueFoundry's
open-source agent harness. Built by **LayaLabs** for the TrueFoundry
Forge-a-thon (Techfest 2026-27, IIT Bombay).

Given a real repository, the agent reads the code, plans a change, edits
several files, and presents every edit for review inside the editor. Nothing
is written to disk silently.

## Starting point

**From scratch.** No fork. The extension is written for this competition; the
agent loop is entirely TrueForge (`@truefoundry/trueforge-sdk`). The editor
side uses only the VS Code API and the official MCP SDK
(`@modelcontextprotocol/sdk`). The MIT license in this repository is ours;
there is no upstream license to preserve because there is no upstream code.

## How it works

```
VS Code extension (this repo)                TrueForge local server (npx @truefoundry/trueforge@latest)
┌───────────────────────────────┐            ┌────────────────────────────────────┐
│ Agent panel (webview chat)    │  session   │  Agent loop: model calls, tool     │
│ Inline edit (Ctrl+I)          │ ─────────► │  loop, approvals, streaming        │
│ Diff review + undo            │  HTTP/SSE  │           │                        │
│ Context assembly (budgeted)   │            │      ▼ streamable HTTP (MCP)       │
│                               │ ◄───────── │  vscode-tools MCP server           │
│                               │  tool call │  (read_file, search_workspace,     │
│                               │            │   propose_write, run_command)      │
└───────────────────────────────┘            └────────────────────────────────────┘
```

- The extension is a **client** of a TrueForge agent: it creates sessions and
  sends turns through the TrueForge TypeScript SDK and renders the streamed
  events (`model.message.delta`, `tool.response`, `tool.approval_required`,
  `turn.done`) in the editor.
- The editor's capabilities are exposed to the agent as **MCP tools**
  (`src/mcpServer.ts`), served over streamable HTTP. The agent, not the
  extension, decides what to read and change.
- `propose_write` **never writes to disk**. It returns a unified diff;
  TrueForge pauses for tool approval, and the user then reviews the diff
  hunk by hunk in VS Code's native diff view. Every applied change can be
  reverted with `Forge: Undo Last Applied Change`.
- **Context assembly** (`src/context.ts`): explicit `@file` mentions plus
  automatic retrieval - identifiers from the instruction are searched with
  ripgrep, files are ranked by identifier strength, and added until the
  configured token budget (`forge.contextBudgetTokens`, default 12000) is
  full. The panel shows which files were chosen and why.
- **Resilience**: cancellation aborts the TrueForge turn and never leaves
  half-applied edits (diffs apply only after review). If the primary model
  fails and `forge.fallbackModel` is set, the request is retried once on the
  fallback with a fresh session; otherwise the user gets a clear error and
  the workspace stays untouched.

## Setup from a clean clone

Prerequisites: Node.js LTS, VS Code, and (for Task B verification) Python
with pytest.

1. **Start TrueForge locally** (separate terminal, leave it running):

   ```sh
   npx @truefoundry/trueforge@latest
   ```

   It serves on `http://localhost:8790`.

2. **Configure a model** in the TrueForge UI (Settings -> Models). Any
   provider works - a free Google Gemini key, or a local Ollama model behind
   its OpenAI-compatible endpoint. See `config/models.example.json` for an
   example. API keys go in TrueForge's settings, never in this repo.

3. **Start the editor tools server** (separate terminal, leave it running):

   ```sh
   # PowerShell: $env:FORGE_WORKSPACE_ROOT="<absolute path to the repo you are editing>"
   # bash:       export FORGE_WORKSPACE_ROOT=<absolute path to the repo you are editing>
   node out/mcpServer.js --http 8791
   ```

   Then register it in the TrueForge UI (Settings -> Connectors -> Add MCP
   Server): name `vscode-tools`, URL `http://localhost:8791/mcp`, auth None.
   (Plain `node out/mcpServer.js` keeps a stdio mode for harnesses that
   spawn MCP processes directly.)

4. **Build the extension:**

   ```sh
   npm install
   npm run compile
   ```

5. **Run it:** open this folder in VS Code and press `F5` (Extension
   Development Host), or package it with `npx @vscode/vsce package` and
   install the `.vsix`.

The agent definition the extension sends is in `agent.yaml` (the extension
passes the same spec inline; the file is the declared definition).

## The three fixed tasks

Repository: `pallets/flask` at tag `3.1.3` (`git checkout 3.1.3`).

- **Task A (inline edit):** open `src/flask/helpers.py`, select
  `get_debug_flag`, press `Ctrl+I`, instruct it to treat `off` and `n` as
  false (case-insensitively) and update the docstring. Review and accept the
  diff. Verify: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`.
- **Task B (agent mode):** in the agent panel, with no files named: "Add a
  new built-in CLI command `flask config` that prints the loaded
  application's configuration as JSON, masking the values of any key
  containing SECRET, PASSWORD, TOKEN or KEY as `***`. It must appear in
  `flask --help`, be covered by a test, and be documented alongside the other
  built-in commands." Review the hunks and accept. Verify:
  `pytest tests/test_cli.py -q` passes and the diff touches 3+ files.
- **Task C (resilience):** point TrueForge at an unreachable endpoint or an
  invalid key and repeat Task A. The editor stays responsive with a clear
  message (or the fallback model takes over), and `git status` shows no
  changes.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `forge.trueforgeBaseUrl` | `http://localhost:8790` | Local TrueForge server |
| `forge.model` | `google/gemini-2.5-flash` | Model as configured in TrueForge |
| `forge.fallbackModel` | _(empty)_ | Second model for automatic failover |
| `forge.mcpServerName` | `vscode-tools` | MCP connector name in TrueForge |
| `forge.contextBudgetTokens` | `12000` | Budget for automatic context retrieval |

## Repo layout

- `src/extension.ts` - activation, commands, wiring
- `src/trueforgeClient.ts` - TrueForge SDK wrapper (sessions, turns, approvals, cancel)
- `src/mcpServer.ts` - MCP server: `read_file`, `search_workspace`, `propose_write`, `run_command`
- `src/agentPanel.ts` - agent chat webview (streaming, approvals, cancel)
- `src/inlineEdit.ts` - inline edit flow
- `src/diffReview.ts` / `src/simpleDiff.ts` - per-hunk review and undo
- `src/context.ts` - @mentions + budgeted automatic retrieval
- `agent.yaml` - the agent definition
- `config/models.example.json` - example model configuration (no keys)

## License

MIT - see `LICENSE`.
