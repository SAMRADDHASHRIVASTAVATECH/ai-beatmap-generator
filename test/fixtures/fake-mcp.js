// Minimal MCP stdio server for tests. Newline-delimited JSON-RPC 2.0.
const fs = require('fs');
let buf = '';
fs.writeFileSync(process.env.FAKE_MCP_PID || require('os').tmpdir() + '/fake-mcp.pid', String(process.pid));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handle(line);
  }
});
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } } });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'flex_echo', description: 'Echo the provided text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  }
  if (method === 'tools/call') {
    const t = params && params.arguments && params.arguments.text ? String(params.arguments.text) : '';
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ECHO:' + t }] } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method ' + method } });
}
