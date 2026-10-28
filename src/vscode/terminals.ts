// Logs and shells in the VS Code terminal panel.
// Logs use a Pseudoterminal: colored lines, Ctrl+C to stop following, and it also works on the demo cluster.

import * as vscode from "vscode";
import type { ExecSpec, KubeClient, Stoppable } from "../kube/client";
import type { LogOptions } from "../kube/types";
import { colorizeLogLine, DIM, RED, RESET } from "../shared/logFormat";

const CTRL_C = "\x03";

class LogsPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private stream?: Stoppable;
  /** Incomplete last line of the previous chunk, colored once complete. */
  private partial = "";

  constructor(
    private readonly client: KubeClient,
    private readonly context: string,
    private readonly opts: LogOptions,
  ) {}

  open(): void {
    this.start();
  }

  private write(text: string): void {
    this.writeEmitter.fire(text);
  }

  private start(): void {
    const o = this.opts;
    const target = `${o.namespace}/${o.pod}${o.container ? ` › ${o.container}` : ` (${vscode.l10n.t("all containers")})`}`;
    const previous = o.previous ? ` · ${vscode.l10n.t("previous container")}` : "";
    this.write(`${DIM}── ${target} · ${this.context}${previous} ── ${vscode.l10n.t("Ctrl+C: stop · R: restart")}${RESET}\r\n`);
    // kubectl logs -l follows the pods running when it starts.
    if (o.selector)
      this.write(`${DIM}── ${vscode.l10n.t("Pods {0}; press R after a rollout to follow the new ones", o.selector)} ──${RESET}\r\n`);
    this.stream = this.client.streamLogs(
      this.context,
      o,
      (chunk) => this.onChunk(chunk),
      (error) => {
        this.flush();
        this.write(
          error
            ? `\r\n${RED}✖ ${error.replace(/\n/g, "\r\n")}${RESET}\r\n`
            : `\r\n${DIM}── ${vscode.l10n.t("end of stream")} ──${RESET}\r\n`,
        );
        this.stream = undefined;
      },
    );
  }

  private onChunk(chunk: string): void {
    const text = this.partial + chunk;
    const cut = text.lastIndexOf("\n");
    if (cut < 0) {
      this.partial = text;
      return;
    }
    this.partial = text.slice(cut + 1);
    const lines = text.slice(0, cut).split("\n").map(colorizeLogLine);
    this.write(`${lines.join("\r\n")}\r\n`);
  }

  private flush(): void {
    if (this.partial) this.write(`${colorizeLogLine(this.partial)}\r\n`);
    this.partial = "";
  }

  handleInput(data: string): void {
    if (data === CTRL_C && this.stream) {
      this.stream.stop();
      this.stream = undefined;
      this.flush();
      this.write(`\r\n${DIM}── ${vscode.l10n.t("stopped (press R to restart)")} ──${RESET}\r\n`);
    } else if (data.toLowerCase() === "r" && !this.stream) {
      this.write("\r\n");
      this.start();
    }
  }

  close(): void {
    this.stream?.stop();
    this.writeEmitter.dispose();
  }
}

export class Terminals implements vscode.Disposable {
  /** One logs terminal per pod/container: opening the same logs again reveals it. */
  private readonly logs = new Map<string, vscode.Terminal>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly client: KubeClient) {
    this.subscription = vscode.window.onDidCloseTerminal((t) => {
      for (const [key, terminal] of this.logs) if (terminal === t) this.logs.delete(key);
    });
  }

  showLogs(context: string, opts: LogOptions): void {
    const key = [context, opts.namespace, opts.pod, opts.selector ?? "", opts.container ?? "*", opts.previous].join("|");
    const existing = this.logs.get(key);
    if (existing) {
      existing.show();
      return;
    }
    const container = opts.container ? ` › ${opts.container}` : "";
    const previous = opts.previous ? ` (${vscode.l10n.t("previous")})` : "";
    const terminal = vscode.window.createTerminal({
      name: vscode.l10n.t("Logs: {0}", `${opts.pod}${container}${previous}`),
      pty: new LogsPseudoterminal(this.client, context, opts),
      iconPath: new vscode.ThemeIcon("output"),
      isTransient: true,
    });
    this.logs.set(key, terminal);
    terminal.show();
  }

  /** Runs a kubectl command in a terminal; false when the cluster has no such command (demo). */
  private open(spec: ExecSpec | undefined, name: string, icon: string): boolean {
    if (!spec) return false;
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: spec.shellPath,
      shellArgs: spec.shellArgs,
      iconPath: new vscode.ThemeIcon(icon),
      isTransient: true,
    });
    terminal.show();
    return true;
  }

  /** Opens `kubectl exec` in a terminal; false when the cluster has no shell (demo). */
  showShell(context: string, namespace: string, pod: string, container: string): boolean {
    return this.open(
      this.client.execSpec(context, namespace, pod, container),
      vscode.l10n.t("Shell: {0}", `${pod} › ${container}`),
      "terminal",
    );
  }

  /** Opens `kubectl debug` in a terminal; false when the cluster has no debug containers (demo). */
  showDebug(context: string, namespace: string, pod: string, container: string, image: string): boolean {
    return this.open(
      this.client.debugSpec(context, namespace, pod, container, image),
      vscode.l10n.t("Debug: {0}", `${pod} › ${container}`),
      "debug",
    );
  }

  /** A root shell on a node (a privileged pod, deleted when the shell exits); false on the demo cluster. */
  showNodeShell(context: string, node: string, image: string): boolean {
    return this.open(this.client.nodeShellSpec(context, node, image), vscode.l10n.t("Node: {0}", node), "terminal-linux");
  }

  /** `kubectl drain`, followed in a terminal (it can take minutes, and be stopped with Ctrl+C); false on the demo cluster. */
  showDrain(context: string, nodes: string[]): boolean {
    return this.open(this.client.drainSpec(context, nodes), vscode.l10n.t("Drain: {0}", nodes.join(", ")), "clear-all");
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
