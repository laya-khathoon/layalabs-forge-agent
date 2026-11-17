/**
 * Inline edit: select code, press Ctrl+I, type an instruction.
 * A TrueForge turn proposes the new file content through the propose_write
 * MCP tool; the diff comes back as a tool response and the user reviews
 * it hunk by hunk before anything is written. On a model/connection
 * failure (Task C) the editor stays responsive, nothing is applied, and -
 * if a fallback model is configured - the request is retried once on it.
 */
import * as vscode from "vscode";
import * as path from "path";
import { ForgeClient } from "./trueforgeClient";
import { buildContext } from "./context";
import { DiffReviewManager } from "./diffReview";
import { reconstructFromUnified } from "./simpleDiff";

export async function inlineEdit(
  getClient: () => ForgeClient,
  retryWithFallback: () => ForgeClient | undefined,
  review: DiffReviewManager,
  budgetTokens: number,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage("Forge: select some code first.");
    return;
  }
  const instruction = await vscode.window.showInputBox({
    prompt: "What should the selected code do differently?",
    placeHolder: "e.g. Treat 'off' and 'n' as false too, and update the docstring",
  });
  if (!instruction) {
    return;
  }

  const doc = editor.document;
  const relPath = vscode.workspace.asRelativePath(doc.uri);
  const ctx = await buildContext(instruction, budgetTokens, { path: relPath, content: doc.getText() });
  const prompt =
    ctx.text +
    `\nThe user selected lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1} in ${relPath}:\n` +
    editor.document.getText(editor.selection) +
    `\n\nInstruction: ${instruction}\n\n` +
    `Rewrite ONLY what the instruction asks for. Call the propose_write tool exactly once, ` +
    `for ${relPath}, with the complete new content of the file. Do not call run_command.`;

  const run = async (client: ForgeClient): Promise<string | undefined> => {
    for await (const ev of client.streamTurn(prompt)) {
      if (ev.type === "tool.approval_required") {
        for (const tc of ev.toolCalls ?? []) {
          await client.approve((ev.threadId as string) ?? "main", tc.id, true);
        }
      }
      if (ev.type === "tool.response") {
        const body = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content ?? "");
        const match = body.match(/Proposed diff .*?:\n([\s\S]*)/);
        if (match) {
          return match[1];
        }
      }
    }
    return undefined;
  };

  let client = getClient();
  let diff: string | undefined;
  try {
    diff = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Forge: thinking...", cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => void client.cancel());
        return run(client);
      },
    );
  } catch (err) {
    const fallback = retryWithFallback();
    if (fallback) {
      vscode.window.showWarningMessage(
        `Forge: primary model failed (${(err as Error).message}). Retrying with the fallback model...`,
      );
      client = fallback;
      try {
        diff = await run(client);
      } catch (err2) {
        vscode.window.showErrorMessage(`Forge: fallback also failed: ${(err2 as Error).message}. No files changed.`);
        return;
      }
    } else {
      vscode.window.showErrorMessage(`Forge: ${(err as Error).message}. No files changed.`);
      return;
    }
  }

  if (!diff) {
    vscode.window.showInformationMessage("Forge: the agent did not propose a diff.");
    return;
  }
  const proposed = reconstructFromUnified(doc.getText(), diff);
  if (proposed === undefined) {
    vscode.window.showErrorMessage("Forge: could not parse the proposed diff. No files changed.");
    return;
  }
  await review.reviewAndApply(doc.uri, proposed, `inline edit to ${relPath}`);
}
