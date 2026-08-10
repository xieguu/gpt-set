import 'dotenv/config';

const configuredHost = process.env.HOST || '127.0.0.1';
const host = configuredHost === '0.0.0.0' || configuredHost === '::' ? '127.0.0.1' : configuredHost;
const port = Number(process.env.PORT || 8787);
const token = process.env.MCP_TOKEN || '';
const headers = process.env.AUTH_MODE === 'none' ? {} : { Authorization: `Bearer ${token}` };

const response = await fetch(`http://${host}:${port}/health`, {
  headers,
  signal: AbortSignal.timeout(5_000),
});
const body = await response.json().catch(() => ({}));

if (!response.ok || body.ok !== true || body.service !== 'gpt-set-local-files') {
  throw new Error(`healthcheck failed: HTTP ${response.status} ${JSON.stringify(body)}`);
}

console.log(JSON.stringify(body));
