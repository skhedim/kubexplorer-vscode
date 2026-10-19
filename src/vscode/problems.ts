// The Problems view of VS Code: the problems found by a Diagnostics tab, on the YAML document of each object
// (clicking one opens it).

import * as vscode from "vscode";
import type { Problem, Severity } from "../resources/diagnostics";
import { resourceUri, YAML_SCHEME } from "./documents";

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export class ProblemsView implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("kubexplorer");
  /** Documents with problems, per context: replaced as a whole by each report. */
  private readonly uris = new Map<string, vscode.Uri[]>();

  report(context: string, problems: Problem[]): void {
    for (const uri of this.uris.get(context) ?? []) this.collection.delete(uri);
    const byUri = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    for (const p of problems) {
      const uri = resourceUri(YAML_SCHEME, context, p.ref, "yaml");
      const entry = byUri.get(uri.toString()) ?? { uri, diagnostics: [] };
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), p.message, SEVERITY[p.severity]);
      diagnostic.source = `KubeXplorer (${p.kind})`;
      diagnostic.code = p.rule;
      entry.diagnostics.push(diagnostic);
      byUri.set(uri.toString(), entry);
    }
    for (const { uri, diagnostics } of byUri.values()) this.collection.set(uri, diagnostics);
    this.uris.set(
      context,
      [...byUri.values()].map((e) => e.uri),
    );
  }

  dispose(): void {
    this.collection.dispose();
  }
}
