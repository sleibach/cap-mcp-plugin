/**
 * Dev-only MCP Apps preview harness (see admin-service.js).
 * @param {import('express').Application} app
 */
module.exports = function registerMcpAppPreview(app) {
  if (process.env.NODE_ENV === "production") return;

  const PREVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MCP Apps Preview — Bookshop</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f5f6f7;color:#1d2d3e}
  header{background:#fff;border-bottom:1px solid #d9d9d9;padding:12px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600}
  label{font-size:13px;color:#556b82}
  select,input,button{font:inherit;padding:6px 10px;border:1px solid #89919a;border-radius:4px;background:#fff}
  button{cursor:pointer;background:#0070f2;color:#fff;border-color:#0070f2}
  button:disabled{opacity:.5;cursor:not-allowed}
  #log{font-size:12px;color:#556b82;flex:1;min-width:200px}
  main{padding:16px}
  #frame-wrap{background:#fff;border:1px solid #d9d9d9;border-radius:8px;overflow:hidden;min-height:480px}
  iframe{width:100%;border:0;display:block;min-height:480px}
  .hint{font-size:13px;color:#556b82;margin:0 0 12px;line-height:1.5}
  .hint code{background:#eef2f5;padding:1px 5px;border-radius:3px}
</style>
</head>
<body>
<header>
  <h1>MCP Apps Preview</h1>
  <label>Resource
    <select id="resource"></select>
  </label>
  <button id="load">Load + fetch data</button>
  <span id="log">Initializing MCP session…</span>
</header>
<main>
  <p class="hint">MCP Apps are <code>ui://…</code> HTML resources — not pages on the CAP root URL. This preview simulates an MCP host: handshake, tool-result push, and <code>tools/call</code> proxy for Create / Edit / Delete. Official inspector: <code>npm run inspect</code> → connect to <code>http://localhost:4004/mcp</code>.</p>
  <div id="frame-wrap"><iframe id="app" title="MCP App" sandbox="allow-scripts allow-same-origin"></iframe></div>
</main>
<script>
const MCP = "/mcp";
const RESOURCES = [
  { uri: "ui://query/AdminService_Books", tool: "admin-books_query", label: "Books — list" },
  { uri: "ui://detail/AdminService_Books", tool: "admin-books_get", label: "Books — detail", getKeys: (rows) => rows[0] ? { ID: rows[0].ID } : {} },
  { uri: "ui://query/AdminService_Authors", tool: "admin-authors_query", label: "Authors — list" },
  { uri: "ui://detail/AdminService_Authors", tool: "admin-authors_get", label: "Authors — detail", getKeys: (rows) => rows[0] ? { ID: rows[0].ID } : {} },
  { uri: "ui://query/AdminService_Genres", tool: "admin-genres_query", label: "Genres — list" },
  { uri: "ui://query/CatalogService_Books", tool: "books_query", label: "Catalog Books — list (read-only)" },
];
let sessionId = null;
const logEl = document.getElementById("log");
const sel = document.getElementById("resource");
const iframe = document.getElementById("app");
RESOURCES.forEach((r, i) => {
  const o = document.createElement("option");
  o.value = i; o.textContent = r.label + " (" + r.uri + ")";
  sel.appendChild(o);
});
function log(msg) { logEl.textContent = msg; }
async function mcp(method, params, id) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = { jsonrpc: "2.0", method, params: params || {} };
  if (id !== undefined) body.id = id;
  const res = await fetch(MCP, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function initSession() {
  const init = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-app-preview", version: "1.0.0" } }, 1);
  if (init.error) throw new Error(init.error.message);
  await mcp("notifications/initialized", {});
  log("MCP session ready");
}
async function readResource(uri) {
  const res = await mcp("resources/read", { uri }, Date.now());
  if (res.error) throw new Error(res.error.message);
  return res.result.contents[0].text;
}
async function callTool(name, args) {
  const res = await mcp("tools/call", { name, arguments: args || {} }, Date.now());
  if (res.error) throw new Error(res.error.message);
  return res.result;
}
function parseToolData(result) {
  if (!result) return null;
  if (result.structuredContent != null) return result.structuredContent;
  try { const t = result.content && result.content[0] && result.content[0].text; return t ? JSON.parse(t) : null; } catch { return null; }
}
window.addEventListener("message", async (ev) => {
  if (ev.source !== iframe.contentWindow) return;
  let m = ev.data;
  if (typeof m === "string") { try { m = JSON.parse(m); } catch { return; } }
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && m.method === "ui/initialize") {
    iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostContext: { theme: "light" } } }, "*");
    return;
  }
  if (m.id !== undefined && m.method === "tools/call") {
    const name = m.params && m.params.name;
    const args = (m.params && m.params.arguments) || {};
    log("tools/call → " + name);
    try {
      const result = await callTool(name, args);
      iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
      log("tools/call ✓ " + name + (result.isError ? " (error)" : ""));
    } catch (e) {
      iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: String(e.message || e) } }, "*");
      log("tools/call ✗ " + name);
    }
  }
});
async function loadApp() {
  const spec = RESOURCES[sel.value];
  log("Loading " + spec.uri + "…");
  const html = await readResource(spec.uri);
  iframe.srcdoc = html;
  const queryRes = await callTool(spec.tool, spec.getKeys ? {} : { top: 50 });
  let payload = parseToolData(queryRes);
  if (spec.getKeys && Array.isArray(payload) && payload.length) {
    payload = parseToolData(await callTool(spec.tool, spec.getKeys(payload)));
  }
  const push = () => iframe.contentWindow.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  }, "*");
  iframe.onload = () => setTimeout(push, 50);
}
document.getElementById("load").onclick = () => loadApp().catch((e) => log("Error: " + e.message));
initSession().then(() => loadApp()).catch((e) => log("Init failed: " + e.message));
</script>
</body>
</html>`;

  app.get("/mcp-app-preview", (_req, res) => {
    res.type("html").send(PREVIEW_HTML);
  });
};
