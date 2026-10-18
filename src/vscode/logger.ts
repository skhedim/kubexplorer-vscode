import * as vscode from "vscode";
import type { Logger } from "../kube/types";

/** The "KubeXplorer" output channel (its level is set with "Developer: Set Log Level..."). */
export function createLogger(): { logger: Logger; channel: vscode.LogOutputChannel } {
  const channel = vscode.window.createOutputChannel("KubeXplorer", { log: true });
  return {
    channel,
    logger: {
      trace: (m) => channel.trace(m),
      info: (m) => channel.info(m),
      warn: (m) => channel.warn(m),
      error: (m) => channel.error(m),
    },
  };
}
