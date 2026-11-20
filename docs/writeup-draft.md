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
streamable HTTP** (`src/mcpServer.ts`, registered in TrueForge as connector
`vscode-tools`; a stdio mode is kept for harnesses that spawn MCP processes
directly): `read_file`, `search_workspace`, `propose_write` and
`run_command`. The agent, not the extension, decides what to read and
change. `propose_write` never touches disk: it returns a unified diff, the
tool is on the approval list (`require_approval_for_tools`), and the user
reviews the diff hunk by hunk in VS Code's native diff view before anything
is applied. Harness features used: **sessions and turns** with streaming
and cancellation, and **MCP tools with human approval** driving the diff
review. TrueForge runs in **local mode**
(`npx @truefoundry/trueforge@latest`); nothing is deployed.

**Resilience.** Small/local models sometimes print a tool call as plain
JSON text instead of making a real tool call. The panel detects that shape
(normalizing argument aliases), executes the call against the MCP server,
and feeds the result back into the turn - with the same approval gate for
writes - so weak models still complete the tool loop. Repeated identical
calls and empty answers are detected and surfaced as clear messages instead
of silent failure. If the primary model fails outright and
`forge.fallbackModel` is set, the request is retried once on the fallback
with a fresh session.

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

- Primary: `google-gemini/gemini-flash-lite-latest` on Google's **free tier**
  (Google AI Studio key, billing off) - cost: **$0**.
- Fallback (Task C): `local-ollama/llama-3-2-3b` running locally - cost:
  **$0**.
- Switching models: change `forge.model` / `forge.fallbackModel` in VS Code
  settings; any model configured in TrueForge works. The API key lives only
  in TrueForge's settings, never in the repo or the editor.

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
| B4 TrueForge depth | [mm:ss] | MCP tools + approval-driven review + streamed turn events |

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
  conventions, streamed inline edits (ghost text) instead of whole-file
  proposals, and deferred tool loading so large tool catalogs stay out of
  context until needed.
