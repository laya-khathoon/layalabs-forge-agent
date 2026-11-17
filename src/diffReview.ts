/**
 * Per-hunk diff review with undo. Nothing is ever written silently:
 * the user sees the diff, accepts or rejects each hunk, and every applied
 * change can be reverted with "Forge: Undo Last Applied Change".
 */
import * as vscode from "vscode";
import * as path from "path";
import { computeDiff, applyHunks, formatUnified, DiffHunk } from "./simpleDiff";

interface LastApply {
  uri: vscode.Uri;
  original: string;
}

export class DiffReviewManager {
  private lastApplied?: LastApply;

  async reviewAndApply(uri: vscode.Uri, proposed: string, title: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();
    const hunks = computeDiff(original, proposed);
    if (hunks.length === 0) {
      vscode.window.showInformationMessage("Forge: the proposal makes no changes.");
      return false;
    }

    // Full preview in VS Code's native diff editor.
    const right = await vscode.workspace.openTextDocument({ content: proposed, language: doc.languageId });
    await vscode.commands.executeCommand(
      "vscode.diff",
      doc.uri,
      right.uri,
      `${path.basename(uri.fsPath)} - proposed by Forge`,
      { preview: true },
    );

    const accepted = new Array<boolean>(hunks.length).fill(false);
    interface Choice extends vscode.QuickPickItem { id: string }
    const choice = await vscode.window.showQuickPick<Choice>(
      [
        { label: "$(check-all) Accept all hunks", id: "all" },
        { label: "$(list-selection) Review hunk by hunk", id: "each" },
        { label: "$(close) Reject all", id: "none" },
      ],
      { placeHolder: `${hunks.length} hunk(s) proposed for ${path.basename(uri.fsPath)}` },
    );
    if (!choice || choice.id === "none") {
      vscode.window.showInformationMessage("Forge: rejected, file untouched.");
      return false;
    }
    if (choice.id === "all") {
      accepted.fill(true);
    } else {
      for (let i = 0; i < hunks.length; i++) {
        const preview = formatUnified([hunks[i]], path.basename(uri.fsPath))
          .split("\n")
          .slice(0, 14)
          .join("\n");
        const pick = await vscode.window.showQuickPick<Choice>(
          [
            { label: "$(check) Accept", id: "y" },
            { label: "$(close) Reject", id: "n" },
          ],
          { placeHolder: `Hunk ${i + 1}/${hunks.length}: ${preview.split("\n")[0]} (details in diff view)` },
        );
        accepted[i] = pick?.id === "y";
        if (!pick) {
          return false; // Escaped: treat as reject-all, nothing applied.
        }
      }
    }

    const updated = applyHunks(original, hunks, accepted);
    if (updated === original) {
      vscode.window.showInformationMessage("Forge: nothing applied, file untouched.");
      return false;
    }
    this.lastApplied = { uri: doc.uri, original };
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), updated);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    vscode.window.showInformationMessage("Forge: applied accepted hunks. Use 'Forge: Undo Last Applied Change' to revert.");
    return true;
  }

  async undoLast(): Promise<void> {
    if (!this.lastApplied) {
      vscode.window.showInformationMessage("Forge: nothing to undo.");
      return;
    }
    const { uri, original } = this.lastApplied;
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    this.lastApplied = undefined;
    vscode.window.showInformationMessage("Forge: last applied change undone.");
  }
}
