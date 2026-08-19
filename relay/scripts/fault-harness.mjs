import { createServer } from "node:http";
import { spawn } from "node:child_process";

const modes = new Set((process.env.PAPYRUS_FAULT_MODE || "delay,duplicate,reorder").split(",").map((mode) => mode.trim()).filter(Boolean));
const delayMs = Number(process.env.PAPYRUS_FAULT_DELAY_MS || 650);
const upstream = "http://127.0.0.1:8788";
const worker = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", "8788"], { stdio: "inherit" });

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks); const path = request.url || "/";
    if (modes.has("offline")) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"Simulated offline relay"}'); return; }
    if (modes.has("delay")) await wait(delayMs);
    const options = { method: request.method, headers: request.headers, body: body.length ? body : undefined };
    const upstreamResponse = await fetch(`${upstream}${path}`, options);
    if (modes.has("duplicate") && request.method === "POST" && path === "/v1/packages" && upstreamResponse.ok) await fetch(`${upstream}${path}`, options);
    const headers = Object.fromEntries(upstreamResponse.headers.entries()); let result = Buffer.from(await upstreamResponse.arrayBuffer());
    if (upstreamResponse.ok && path === "/v1/packages/fetch" && (modes.has("duplicate") || modes.has("reorder"))) {
      const payload = JSON.parse(result.toString("utf8"));
      if (modes.has("reorder")) payload.packages.reverse();
      if (modes.has("duplicate") && payload.packages.length) payload.packages.push(payload.packages[0]);
      result = Buffer.from(JSON.stringify(payload)); headers["content-length"] = String(result.length);
    }
    response.writeHead(upstreamResponse.status, headers); response.end(result);
  } catch {
    response.writeHead(502, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Fault harness upstream unavailable" }));
  }
});

server.listen(8787, "127.0.0.1", () => console.log(`Pad fault harness on http://127.0.0.1:8787 (${Array.from(modes).join(", ") || "no faults"})`));
const close = () => { server.close(); worker.kill("SIGTERM"); };
process.on("SIGINT", close); process.on("SIGTERM", close); worker.on("exit", () => server.close());
