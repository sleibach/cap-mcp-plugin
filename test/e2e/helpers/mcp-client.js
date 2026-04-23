"use strict";

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

/**
 * Create an authenticated MCP client against a running server.
 * Uses the Streamable-HTTP transport with a Basic-auth header so the
 * CAP auth middleware sees a per-session user identity.
 *
 * @param {string} baseUrl  http://host:port base of the CAP server
 * @param {string} username CAP mocked-auth username (password is empty)
 * @returns {{call:(name:string,args?:object)=>Promise<any>, listTools:()=>Promise<any>, close:()=>Promise<void>, client:Client}}
 */
async function createMcpClient(baseUrl, username) {
  const token = Buffer.from(`${username}:`).toString("base64");
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: {
      headers: { Authorization: `Basic ${token}` },
    },
  });

  const client = new Client({ name: `test-${username}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args || {} });
    const text = res?.content?.[0]?.text ?? "";
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    }
    return { isError: !!res?.isError, text, parsed, raw: res };
  }

  return {
    client,
    call,
    listTools: () => client.listTools(),
    close: () => client.close(),
  };
}

module.exports = { createMcpClient };
