import { HOST, VERSION, record, type NativeReply } from "./protocol";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class Native {
  private port?: chrome.runtime.Port;
  private pending = new Map<string, Pending>();
  private chunks = new Map<
    string,
    { bytes: number; next: number; total: number; parts: Uint8Array[] }
  >();
  onDisconnect: () => void = () => {};
  connect(): void {
    if (this.port) return;
    const port = chrome.runtime.connectNative(HOST);
    this.port = port;
    port.onMessage.addListener((value: unknown) => {
      if (this.port === port) this.receive(value);
    });
    port.onDisconnect.addListener(() => {
      const error =
        chrome.runtime.lastError?.message ?? "Native backend disconnected";
      if (this.port !== port) return;
      this.port = undefined;
      this.fail(new Error(error));
      this.onDisconnect();
    });
  }
  disconnect(): void {
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
    this.fail(new Error("Native backend reconnecting"));
    this.onDisconnect();
  }
  request<T = unknown>(type: string, params: unknown = {}): Promise<T> {
    if (this.pending.size >= 64)
      return Promise.reject(new Error("Native request queue full"));
    this.connect();
    const request_id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        this.chunks.delete(request_id);
        reject(new Error("Native backend timed out"));
        this.disconnect();
      }, 20_000);
      this.pending.set(request_id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.port!.postMessage({ version: VERSION, request_id, type, params });
    });
  }
  private receive(value: unknown): void {
    try {
      if (
        !record(value) ||
        typeof value.request_id !== "string" ||
        !this.pending.has(value.request_id)
      )
        return;
      if (value.type === "chunk") {
        if (
          !Number.isInteger(value.index) ||
          !Number.isInteger(value.total) ||
          typeof value.data !== "string" ||
          Number(value.total) < 1 ||
          Number(value.total) > 17 ||
          value.data.length > 700_000
        )
          throw new Error("Invalid native chunk");
        let chunks = this.chunks.get(value.request_id);
        if (!chunks) {
          chunks = { bytes: 0, next: 0, total: Number(value.total), parts: [] };
          this.chunks.set(value.request_id, chunks);
        }
        if (value.index !== chunks.next || value.total !== chunks.total)
          throw new Error("Native chunk sequence mismatch");
        const part = Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
        chunks.bytes += part.length;
        if (chunks.bytes > 8 * 1024 * 1024)
          throw new Error("Native snapshot too large");
        chunks.parts.push(part);
        chunks.next++;
        if (chunks.next !== chunks.total) return;
        this.chunks.delete(value.request_id);
        const joined = new Uint8Array(chunks.bytes);
        let offset = 0;
        for (const part of chunks.parts) {
          joined.set(part, offset);
          offset += part.length;
        }
        const decoded: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(joined),
        );
        if (!record(decoded) || decoded.request_id !== value.request_id)
          throw new Error("Native chunk request mismatch");
        this.receive(decoded);
        return;
      }
      const reply = value as unknown as NativeReply;
      if (
        reply.version !== VERSION ||
        (reply.error !== undefined && typeof reply.error !== "string")
      )
        throw new Error("Unsupported native response");
      const pending = this.pending.get(reply.request_id)!;
      clearTimeout(pending.timer);
      this.pending.delete(reply.request_id);
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.result);
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("Invalid native response"),
      );
      this.disconnect();
    }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.chunks.clear();
  }
}
