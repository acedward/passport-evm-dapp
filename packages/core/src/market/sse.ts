// A minimal server-sent-events parser (the WHATWG event-stream format), so the offer stream can
// be read through `fetch` in the browser and in Node alike: EventSource is browser-only, hides
// the HTTP status (the kernel answers 503 with Retry-After when its stream slots are full) and
// cannot be given a timeout.

export interface SseMessage {
  /** The `event:` field, or 'message'. */
  event: string;
  /** The `data:` lines joined with '\n'. */
  data: string;
  /** The `id:` field, if any. */
  id: string | null;
}

export type SseItem = { kind: 'message'; message: SseMessage } | { kind: 'comment'; text: string };

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | null = null;

  /** Feed decoded text; returns every complete message and comment it finished. */
  push(text: string): SseItem[] {
    this.buffer += text;
    const out: SseItem[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone '\r' at the very end may be the first half of '\r\n': wait for more.
      if (m[0] === '\r' && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseItem[]): void {
    if (line === '') {
      if (this.data.length > 0) {
        out.push({
          kind: 'message',
          message: { event: this.event || 'message', data: this.data.join('\n'), id: this.id },
        });
      }
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) {
      out.push({ kind: 'comment', text: line.slice(1).trimStart() });
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    // 'retry' and unknown fields are ignored.
  }
}
