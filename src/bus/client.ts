import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { BusFrame } from "../types/index.js";
import { paths } from "../platform/paths.js";

export interface BusClientOptions {
  socketPath?: string;
}

export class BusClient extends EventEmitter {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private connected = false;
  readonly socketPath: string;

  constructor(opts: BusClientOptions = {}) {
    super();
    this.socketPath = opts.socketPath ?? paths().socket;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ path: this.socketPath });
      sock.once("connect", () => {
        this.socket = sock;
        this.connected = true;
        sock.on("data", (chunk) => {
          try {
            for (const frame of this.decoder.push(chunk)) {
              this.emit("frame", frame);
            }
          } catch (err) {
            this.emit("error", err);
          }
        });
        sock.on("error", (err) => this.emit("error", err));
        sock.on("close", () => {
          this.connected = false;
          this.emit("close");
        });
        resolve();
      });
      sock.once("error", (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  send(frame: BusFrame): void {
    if (!this.socket) throw new Error("BusClient not connected");
    this.socket.write(encodeFrame(frame));
  }

  close(): void {
    this.socket?.end();
  }

  /** Send a frame and wait for the next frame back. Simple request/response. */
  request(frame: BusFrame, timeoutMs = 5_000): Promise<BusFrame> {
    return new Promise((resolve, reject) => {
      const onFrame = (f: BusFrame) => {
        cleanup();
        resolve(f);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`bus request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("frame", onFrame);
        this.off("error", onError);
      };
      this.once("frame", onFrame);
      this.once("error", onError);
      this.send(frame);
    });
  }
}
