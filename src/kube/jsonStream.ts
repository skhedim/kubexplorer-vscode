// Splits a text stream into consecutive JSON objects (output of `kubectl get --watch -o json`),
// whether they are compact, indented, or cut anywhere between two chunks.

export class JsonStreamParser {
  private buffer = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private start = -1;
  /** Length of the buffer prefix already scanned. */
  private scanned = 0;

  constructor(private readonly onObject: (value: unknown) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.scanned; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === "{") {
        if (this.depth++ === 0) this.start = i;
      } else if (c === "}" && this.depth > 0 && --this.depth === 0) {
        const text = this.buffer.slice(this.start, i + 1);
        // Drop what has been consumed and rescan the rest from its beginning.
        this.buffer = this.buffer.slice(i + 1);
        i = -1;
        this.start = -1;
        this.emit(text);
      }
    }
    // Outside of an object there is nothing to keep (whitespace, stray messages).
    if (this.depth === 0) this.buffer = "";
    this.scanned = this.buffer.length;
  }

  private emit(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return; // Truncated or corrupted object: skipped, the periodic resync catches up.
    }
    this.onObject(value);
  }
}
