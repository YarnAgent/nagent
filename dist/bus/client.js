import { createConnection } from "node:net";
import { EventEmitter } from "node:events";
import { encodeFrame, FrameDecoder } from "./frame.js";
import { paths } from "../platform/paths.js";
export class BusClient extends EventEmitter {
    socket = null;
    decoder = new FrameDecoder();
    connected = false;
    socketPath;
    constructor(opts = {}) {
        super();
        this.socketPath = opts.socketPath ?? paths().socket;
    }
    connect() {
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
                    }
                    catch (err) {
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
                if (!this.connected)
                    reject(err);
            });
        });
    }
    send(frame) {
        if (!this.socket)
            throw new Error("BusClient not connected");
        this.socket.write(encodeFrame(frame));
    }
    close() {
        this.socket?.end();
    }
    /** Send a frame and wait for the next frame back. Simple request/response. */
    request(frame, timeoutMs = 5_000) {
        return new Promise((resolve, reject) => {
            const onFrame = (f) => {
                cleanup();
                resolve(f);
            };
            const onError = (err) => {
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
//# sourceMappingURL=client.js.map