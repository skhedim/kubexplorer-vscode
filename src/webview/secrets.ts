// The Secret values of the object shown in the drawer: revealed one at a time, on request, and never persisted; edited
// in place (a draft per key) and saved through the extension. The App routes the clicks and messages here, and renders
// what view() returns.

import type { WebviewMessage } from "../shared/protocol";
import type { ResourceRef } from "../shared/view";
import type { SecretView } from "./render";

export class SecretEdits {
  /** Values revealed. */
  readonly values = new Map<string, string>();
  /** Values asked for, not received yet. */
  readonly pending = new Set<string>();
  readonly errors = new Map<string, string>();
  /** Values being edited, and those being saved. */
  readonly drafts = new Map<string, string>();
  readonly saving = new Set<string>();
  /** Keys to edit once their value arrives. */
  private readonly editRequested = new Set<string>();

  constructor(private readonly post: (msg: WebviewMessage) => void) {}

  clear(): void {
    this.values.clear();
    this.pending.clear();
    this.errors.clear();
    this.drafts.clear();
    this.saving.clear();
    this.editRequested.clear();
  }

  private ask(ref: ResourceRef, key: string): void {
    this.errors.delete(key);
    this.pending.add(key);
    this.post({ type: "revealSecret", ref, key });
  }

  /** Reveals a value, or hides it again. */
  toggle(ref: ResourceRef, key: string): void {
    if (!this.values.delete(key)) this.ask(ref, key);
  }

  /** Edits a value in place, revealed first when hidden; true when its editor opens now (to focus it). */
  edit(ref: ResourceRef, key: string): boolean {
    const value = this.values.get(key);
    if (value !== undefined) return this.startEdit(key, value);
    this.editRequested.add(key);
    this.ask(ref, key);
    return false;
  }

  private startEdit(key: string, value: string): boolean {
    this.errors.delete(key);
    this.drafts.set(key, value);
    return true;
  }

  save(ref: ResourceRef, key: string): void {
    const value = this.drafts.get(key);
    if (value === undefined || this.saving.has(key)) return;
    this.errors.delete(key);
    this.saving.add(key);
    this.post({ type: "updateSecret", ref, key, value });
  }

  cancel(key: string): void {
    this.drafts.delete(key);
    this.errors.delete(key);
  }

  /**
   * A value arrived (revealSecret); `current`: it belongs to the object still shown. True when an edit asked for it:
   * its editor opens (to focus it).
   */
  received(msg: { key: string; value?: string; error?: string }, current: boolean): boolean {
    this.pending.delete(msg.key);
    const edit = this.editRequested.delete(msg.key);
    if (msg.error) this.errors.set(msg.key, msg.error);
    else if (msg.value !== undefined && current) {
      this.values.set(msg.key, msg.value);
      if (edit) return this.startEdit(msg.key, msg.value);
    }
    return false;
  }

  /** The outcome of a save: the new value stays shown, like a revealed one. */
  updated(msg: { key: string; saved: boolean; error?: string }): void {
    this.saving.delete(msg.key);
    const draft = this.drafts.get(msg.key);
    if (msg.error) this.errors.set(msg.key, msg.error);
    else if (msg.saved && draft !== undefined) {
      this.drafts.delete(msg.key);
      this.values.set(msg.key, draft);
    }
  }

  /** What the drawer shows; `editable` is false on a read-only context. */
  view(editable: boolean): Omit<SecretView, "ref"> {
    return { values: this.values, pending: this.pending, errors: this.errors, drafts: this.drafts, saving: this.saving, editable };
  }
}
