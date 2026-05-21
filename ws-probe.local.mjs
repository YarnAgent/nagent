// Probe a LOCAL ttyd via its Unix socket. usage: node ws-probe.local.mjs unix:<sock>
import { WebSocket } from "ws";

const target = process.argv[2];
if (!target?.startsWith("unix:")) { console.error("usage: unix:<sock>"); process.exit(2); }
const sock = target.slice(5);

// ws supports the ws+unix:// scheme.
const url = `ws+unix://${sock}:/ws`;
const ws = new WebSocket(url, ["tty"], { perMessageDeflate: false, skipUTF8Validation: true });

let bytesSeen = 0;
let firstBytes = "";

ws.on("open", () => {
  console.log("ws open");
  ws.send("{" + JSON.stringify({ AuthToken: "", columns: 120, rows: 32 }));
  setTimeout(() => { try { ws.send("0echo HELLO_FROM_PROBE\n"); console.log("sent cmd"); } catch { /**/ } }, 300);
});
ws.on("message", (data, isBinary) => {
  const buf = typeof data === "string" ? Buffer.from(data, "binary") : Buffer.from(data);
  bytesSeen += buf.length;
  if (firstBytes.length < 200) firstBytes += buf.toString("utf8", 0, Math.min(buf.length, 200 - firstBytes.length));
  if (buf.includes("HELLO_FROM_PROBE")) {
    console.log(`✓ sentinel found (${bytesSeen} bytes total)`);
    ws.close();
  }
});
ws.on("close", (code, reason) => {
  console.log(`close ${code}: ${reason}`);
  console.log(`bytes seen: ${bytesSeen}`);
  console.log(`first chunk preview: ${JSON.stringify(firstBytes)}`);
  process.exit(0);
});
ws.on("error", (err) => { console.error("error:", err.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 8_000);
