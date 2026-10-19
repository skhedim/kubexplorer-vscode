// Protected contexts (kubexplorer.protectedContexts), e.g. production: every change asks to type the name of
// its target, or is refused when the context is read-only.

import * as vscode from "vscode";
import { contextProtection, isAllowed, type Protection } from "../shared/protection";
import type { ActionId } from "../shared/view";
import { config } from "./config";

export interface Confirmation {
  /** E.g. "Delete Pod default/web?" */
  question: string;
  detail: string;
  /** Label of the button of the modal dialog. */
  verb: string;
  /** What to type on a protected context: the name of the target. */
  expected: string;
  /** Also ask on ordinary contexts, with a modal dialog. */
  modal: boolean;
}

export class ContextGuard implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** The settings changed: the protection of the contexts may have too. */
  readonly onDidChange = this.emitter.event;
  private readonly subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("kubexplorer.protectedContexts") || e.affectsConfiguration("kubexplorer.protectedContextsMode"))
      this.emitter.fire();
  });

  protection(context: string): Protection {
    return contextProtection(context, config.protectedContexts(), config.protectedContextsMode());
  }

  /** Whether the context allows the action; when it does not, says why. */
  allows(context: string, action: ActionId): boolean {
    if (isAllowed(action, this.protection(context))) return true;
    this.refuse(context);
    return false;
  }

  refuse(context: string): void {
    const settings = vscode.l10n.t("Open Settings");
    void vscode.window
      .showErrorMessage(vscode.l10n.t("KubeXplorer: {0} is read-only (kubexplorer.protectedContexts).", context), settings)
      .then((choice) => {
        if (choice === settings) void vscode.commands.executeCommand("workbench.action.openSettings", "kubexplorer.protectedContexts");
      });
  }

  /**
   * Confirms a change: refused on a read-only context, the name of its target typed on a protected one,
   * a modal dialog (when `modal`) on the others. Resolves to true to go ahead.
   */
  async confirm(context: string, c: Confirmation): Promise<boolean> {
    const protection = this.protection(context);
    if (protection === "readOnly") {
      this.refuse(context);
      return false;
    }
    if (protection === "confirm") return this.typed(context, c);
    if (!c.modal) return true;
    return (await vscode.window.showWarningMessage(c.question, { modal: true, detail: c.detail }, c.verb)) === c.verb;
  }

  private async typed(context: string, c: Confirmation): Promise<boolean> {
    const hint = vscode.l10n.t("Type {0} to confirm", `"${c.expected}"`);
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t("Protected context {0} — {1}", context, c.question),
      prompt: `${c.detail.replace(/\n+/g, " · ")} — ${hint}`,
      placeHolder: c.expected,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v === c.expected
          ? undefined
          : {
              message: hint,
              severity: c.expected.startsWith(v) ? vscode.InputBoxValidationSeverity.Info : vscode.InputBoxValidationSeverity.Error,
            },
    });
    if (value === c.expected) return true;
    if (value !== undefined) vscode.window.setStatusBarMessage(`$(close) ${vscode.l10n.t("Not confirmed: the name did not match")}`, 4000);
    return false;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
