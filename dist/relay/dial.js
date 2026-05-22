// stdin/stdout bridge used as ssh's ProxyCommand. Connects to the local
// relay-client's IPC socket, asks for an outbound stream to <peer> via
// <relayName>, and pipes process.stdin/stdout to the byte stream once the
// relay-client confirms OPEN_OK.
import { connect as netConnect } from "node:net";
/**
 * Run the dialer. Resolves with the process exit code (0 on clean stream
 * close, non-zero on error).
 */
export function relayDial(opts) {
    const stdin = opts.stdin ?? process.stdin;
    const stdout = opts.stdout ?? process.stdout;
    const stderr = opts.stderr ?? process.stderr;
    const timeoutMs = opts.openTimeoutMs ?? 5_000;
    return new Promise((resolve) => {
        const ipc = netConnect(opts.ipcSockPath);
        let opened = false;
        let buf = Buffer.alloc(0);
        const die = (code, msg) => {
            if (msg)
                stderr.write(`nagent relay-dial: ${msg}\n`);
            try {
                ipc.destroy();
            }
            catch { /* */ }
            try {
                stdin.removeListener("data", onStdin);
            }
            catch { /* */ }
            resolve(code);
        };
        const timeout = setTimeout(() => {
            if (!opened)
                die(2, `OPEN timed out after ${timeoutMs} ms (relay=${opts.relayName} peer=${opts.peerNodeName})`);
        }, timeoutMs);
        ipc.on("connect", () => {
            const header = JSON.stringify({ v: 1, cmd: "dial", relay: opts.relayName, peer: opts.peerNodeName }) + "\n";
            ipc.write(header);
        });
        ipc.on("data", (chunk) => {
            if (!opened) {
                buf = Buffer.concat([buf, chunk]);
                const nl = buf.indexOf(0x0a);
                if (nl < 0)
                    return;
                const headerLine = buf.subarray(0, nl).toString("utf8");
                const remainder = buf.subarray(nl + 1);
                let reply;
                try {
                    reply = JSON.parse(headerLine);
                }
                catch {
                    die(2, `bad reply from relay-client: ${headerLine}`);
                    return;
                }
                if (!reply.ok) {
                    die(2, `OPEN rejected: ${reply.reason ?? "unknown"}`);
                    return;
                }
                opened = true;
                clearTimeout(timeout);
                if (remainder.length)
                    stdout.write(remainder);
                stdin.on("data", onStdin);
                if ("resume" in stdin && typeof stdin.resume === "function") {
                    stdin.resume();
                }
                return;
            }
            // After OPEN_OK, raw bytes flow.
            stdout.write(chunk);
        });
        const onStdin = (chunk) => {
            try {
                ipc.write(chunk);
            }
            catch { /* */ }
        };
        stdin.on("end", () => {
            try {
                ipc.end();
            }
            catch { /* */ }
        });
        ipc.on("end", () => { if (opened)
            die(0); });
        ipc.on("close", () => { if (opened)
            die(0);
        else
            die(2, "IPC closed before OPEN_OK"); });
        ipc.on("error", (err) => die(2, `IPC error: ${err.message}`));
    });
}
//# sourceMappingURL=dial.js.map