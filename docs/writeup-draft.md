# Layalabs Forge Agent - Round 1 write-up (DRAFT, 1-3 pages when exported)

> Draft for review. Fill the bracketed parts after recording the demo video.

## 1. Team

- **Laya Khathoon** (team **LayaLabs**, solo), B.Tech student (2027 batch), Kerala, India.
- GitHub: [github.com/laya-khathoon](https://github.com/laya-khathoon)
- Team ID: TM-885A53293C8. Competition: TrueFoundry Forge-a-thon, Techfest 2026-27 (IIT Bombay).

## 2. Starting point

**From scratch.** No upstream repository or fork. The extension is original
code written for this competition; the agent loop is entirely TrueForge.
The only dependencies are the TrueForge TypeScript SDK
(`@truefoundry/trueforge-sdk`), the official MCP SDK
(`@modelcontextprotocol/sdk`), and the VS Code API. Our code is MIT
licensed; there is no upstream license to preserve.

## 3. Architecture on TrueForge

The extension is a **client** of a TrueForge agent. It creates sessions with
an inline agent spec and streams turns through the TrueForge TypeScript SDK
(`sessions.create`, `sessions.createTurnStream`); streamed events
(`model.message.delta`, `tool.response`, `tool.approval_required`,
`turn.done`) are rendered live in the editor panel.

The editor's capabilities are exposed to the agent as an **MCP server over
stdio** (`src/mcpServer.ts`, registered in TrueForge as connector
`vscode-tools`): `read_file`, `search_workspace`, `propose_write`,
`run_command`. The agent, not the extension, decides what to read and
change. `propose_write` **never writes to disk**: it returns a unified
diff; TrueForge pauses for tool approval, and the user then reviews the
diff hunk by hunk in VS Code's native diff view. Every applied change can
be reverted with `Forge: Undo Last Applied Change`. Harness features used:
**sessions and turns** with streaming and cancellation, **MCP tools with
human approval** driving the diff review, and **deferred tool loading**
(tools load on demand rather than eagerly into context). TrueForge runs in
**local mode** (`npx @truefoundry/trueforge@latest`); nothing is deployed.

## 4. How context is selected

`src/context.ts`. Strategy and budget:

1. The file and selection the user is editing always fit first.
2. Explicit `@file` mentions are resolved against the workspace.
3. Automatic retrieval: identifiers are extracted from the instruction
   (stop-words removed, longest first), searched across the repo with
   ripgrep, and files are ranked by total identifier strength. Top files
   are added until the configured budget (`forge.contextBudgetTokens`,
   default **12,000 tokens**) is full; files are clipped at the budget edge.

The agent panel prints the chosen files, the reason each was picked, and
the budget used, so the selection is visible during Task B. Whole files are
never concatenated blindly.

## 5. Model setup

The extension never calls a model provider directly; models are configured
in TrueForge (catalog provider or any OpenAI-compatible endpoint).

- Primary: `google/gemini-2.5-flash` on Google's **free tier** (Google AI
  Studio key, billing off) - cost: **$0**.
- Fallback (Task C): `ollama/llama3.2` running locally - cost: **$0**.
- Switching models: change `forge.model` / `forge.fallbackModel` in VS Code
  settings; any model configured in TrueForge works.

See `config/models.example.json`.

## 6. Scorecard

| Criterion | Video timestamp | Claim |
| --- | --- | --- |
| A1 Inline edit | [mm:ss] | Diff rendered in editor, per-hunk accept/reject |
| A2 Agent mode | [mm:ss] | Discovers and edits 3+ files unprompted (Task B) |
| A3 Streaming + cancellation | [mm:ss] | Tokens stream live; cancel is immediate, workspace consistent |
| B1 Context assembly | [mm:ss] | Budgeted retrieval, chosen files shown with reasons |
| B2 Diff safety | [mm:ss] | Per-hunk review + working undo shown on screen |
| B3 Resilience | [mm:ss] | Clear error / fallback model, `git status` clean |
| B4 TrueForge depth | [mm:ss] | MCP tools + approval-driven review + deferred tool loading |

## 7. Tools used

- TrueForge (`@truefoundry/trueforge`, `@truefoundry/trueforge-sdk`) - agent harness
- `@modelcontextprotocol/sdk` - MCP server for the editor tools
- VS Code Extension API - editor integration
- ripgrep - workspace search (with a graceful fallback)
- AI assistance during development: Instinct (personal AI assistant) for
  scaffolding and this write-up draft; every behaviour was tested by hand
  against the fixed tasks.

## 8. Known limitations and one more month

- Retrieval is lexical (identifier search), not semantic; with more time we
  would add embeddings with the same budget discipline.
- The diff is line-based; moved blocks show as delete+add.
- `propose_write` sends whole-file content; large files should move to
  range edits.
- Tool approval is per call; a session-level approval policy
  (`user.tool_approval_policy`) would cut repetitive prompts.
- With another month: subagents for exploration, a skill pack for Flask's
  conventions, and streamed inline edits (ghost text) instead of
  whole-file proposals.
