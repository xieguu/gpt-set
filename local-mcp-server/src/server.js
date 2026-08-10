import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || path.join(process.cwd(), 'workspace'));
const authMode = process.env.AUTH_MODE || 'bearer';
const token = process.env.MCP_TOKEN || '';
const SERVICE_NAME = 'gpt-set-local-files';
const SERVICE_VERSION = '0.1.0';
const instanceId = String(process.env.INSTANCE_ID || 'default').trim() || 'default';
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT 必须是 0 到 65535 之间的整数，当前值：${process.env.PORT}`);
}
if (!['bearer', 'none'].includes(authMode)) {
  throw new Error(`AUTH_MODE 只允许 bearer 或 none，当前值：${authMode}`);
}
const IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

await fs.mkdir(workspaceRoot, { recursive: true });
const rootRealPath = await fs.realpath(workspaceRoot);
const bridgeInbox = path.join(rootRealPath, '.chatgpt-image-inbox');
await fs.mkdir(bridgeInbox, { recursive: true });

function isInsideRoot(candidate) {
  const relative = path.relative(rootRealPath, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function cleanRelativePath(value = '') {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('路径无效。');
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (path.isAbsolute(value) || normalized.split('/').includes('..')) throw new Error('只接受工作区内的相对路径。');
  return normalized === '.' ? '' : normalized;
}
async function existingPath(relativePath = '') {
  const fullPath = path.resolve(rootRealPath, cleanRelativePath(relativePath));
  const realPath = await fs.realpath(fullPath);
  if (!isInsideRoot(realPath)) throw new Error('路径越出工作区。');
  const stat = await fs.lstat(realPath);
  if (stat.isSymbolicLink()) throw new Error('不允许操作符号链接。');
  return realPath;
}
async function ensureSafeDirectory(relativeDirectory = '') {
  const clean = cleanRelativePath(relativeDirectory);
  if (!clean) return rootRealPath;
  let current = rootRealPath;
  for (const segment of clean.split('/')) {
    const candidate = path.join(current, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error('不允许经过符号链接目录。');
      if (!stat.isDirectory()) throw new Error('父路径包含非目录项目。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(candidate);
    }
    const realCandidate = await fs.realpath(candidate);
    if (!isInsideRoot(realCandidate)) throw new Error('父目录越出工作区。');
    current = realCandidate;
  }
  return current;
}
async function targetPath(relativePath, { createParents = false } = {}) {
  const clean = cleanRelativePath(relativePath);
  if (!clean) throw new Error('不能对工作区根目录执行此操作。');
  const segments = clean.split('/');
  const name = segments.pop();
  const parentRelative = segments.join('/');
  const parentRealPath = createParents
    ? await ensureSafeDirectory(parentRelative)
    : await existingPath(parentRelative);
  const parentStat = await fs.stat(parentRealPath);
  if (!parentStat.isDirectory()) throw new Error('父路径不是目录。');
  const fullPath = path.join(parentRealPath, name);
  if (!isInsideRoot(fullPath)) throw new Error('路径越出工作区。');
  try {
    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) throw new Error('不允许覆盖符号链接。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return fullPath;
}
function requestAuthorized(req) {
  if (authMode === 'none') return true;
  return Boolean(token) && (req.get('authorization') === ('Bearer ' + token) || req.query.token === token || req.get('x-mcp-token') === token);
}
function asText(message) { return { content: [{ type: 'text', text: message }] }; }
function extensionMime(filePath) { return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase()); }
function isTextFile(filePath) { return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()); }
function isBlockedIpv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}
function mappedIpv4(address) {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return '';
  const tail = lower.slice(7);
  if (net.isIPv4(tail)) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return '';
  const high = Number.parseInt(parts[0], 16); const low = Number.parseInt(parts[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
function isPublicAddress(address) {
  if (net.isIPv4(address)) return !isBlockedIpv4(address);
  if (!net.isIPv6(address)) return false;
  const mapped = mappedIpv4(address);
  if (mapped) return !isBlockedIpv4(mapped);
  const lower = address.toLowerCase();
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !lower.startsWith('2001:db8:');
}
async function publicImageTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('图片地址必须是无凭据的 HTTPS URL。');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('不允许下载指向本机、私有或保留网络的图片。');
  return { url, ...(addresses.find(({ family }) => family === 4) || addresses[0]) };
}
function downloadImage({ url, address, family }, expectedMime) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    const request = https.get(url, {
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(new Error(`下载图片失败：HTTP ${response.statusCode || '未知'}。`));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
      if (contentType !== expectedMime) {
        response.resume();
        fail(new Error(`图片类型不匹配：URL 返回 ${contentType || '未知'}，目标要求 ${expectedMime}。`));
        return;
      }
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        response.destroy();
        fail(new Error('图片超过 10 MB 限制。'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_IMAGE_BYTES) {
          response.destroy(new Error('图片超过 10 MB 限制。'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        const bytes = Buffer.concat(chunks, total);
        if (!bytes.length) return fail(new Error('图片内容为空。'));
        settled = true;
        resolve(bytes);
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error('下载图片超时。')));
    request.once('error', fail);
  });
}
function safeBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(value)) throw new Error('图片必须是 Base64 编码。');
  return Buffer.from(value.replace(/\s/g, ''), 'base64');
}

function makeServer() {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  const pathSchema = z.object({ path: z.string().default('').describe('相对于固定工作区的路径') });

  server.registerTool('list_directory', {
    title: '列出目录', description: '列出固定工作区中一个目录的直接子项。', inputSchema: pathSchema.shape,
  }, async ({ path: relativePath }) => {
    const directory = await existingPath(relativePath);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error('目标不是目录。');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const rows = await Promise.all(entries.map(async (entry) => {
      const full = path.join(directory, entry.name); const info = await fs.lstat(full);
      return { name: entry.name, type: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink-blocked' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() };
    }));
    return asText(JSON.stringify({ path: cleanRelativePath(relativePath), entries: rows }, null, 2));
  });

  server.registerTool('read_file', {
    title: '读取文件', description: '读取固定工作区中的文本或图片。图片会作为图像内容传回对话。', inputSchema: pathSchema.shape,
  }, async ({ path: relativePath }) => {
    const filePath = await existingPath(relativePath); const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('目标不是普通文件。');
    const mimeType = extensionMime(filePath);
    if (mimeType) {
      if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB 限制。');
      return { content: [{ type: 'image', data: (await fs.readFile(filePath)).toString('base64'), mimeType }, { type: 'text', text: `已读取图片：${cleanRelativePath(relativePath)}` }] };
    }
    if (!isTextFile(filePath) || stat.size > MAX_TEXT_BYTES) throw new Error('仅允许读取 2 MB 内的指定文本类型或图片。');
    return asText(await fs.readFile(filePath, 'utf8'));
  });

  server.registerTool('write_text', {
    title: '写入文本', description: '在固定工作区创建或覆盖 UTF-8 文本文件。', inputSchema: { path: z.string(), content: z.string().max(MAX_TEXT_BYTES), overwrite: z.boolean().default(true) },
  }, async ({ path: relativePath, content, overwrite }) => {
    const filePath = await targetPath(relativePath, { createParents: true });
    if (!isTextFile(filePath)) throw new Error('仅允许写入白名单文本扩展名。');
    if (!overwrite) { try { await fs.access(filePath); throw new Error('文件已存在，overwrite=false。'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await fs.writeFile(filePath, content, 'utf8');
    return asText(`已写入 ${cleanRelativePath(relativePath)}（${Buffer.byteLength(content, 'utf8')} bytes）。`);
  });

  server.registerTool('write_image', {
    title: '写入图片', description: '在固定工作区写入 PNG、JPEG、WebP 或 GIF 图片；data 必须为 Base64。', inputSchema: { path: z.string(), data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) },
  }, async ({ path: relativePath, data, mimeType }) => {
    const filePath = await targetPath(relativePath, { createParents: true }); const expectedMime = extensionMime(filePath);
    if (expectedMime !== mimeType) throw new Error('文件扩展名必须匹配 mimeType。');
    const bytes = safeBase64(data); if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片必须在 1 byte 到 10 MB 之间。');
    await fs.writeFile(filePath, bytes);
    return asText(`已保存图片 ${cleanRelativePath(relativePath)}（${bytes.length} bytes）。`);
  });

  server.registerTool('save_image_from_url', {
    title: '从 URL 保存图片', description: '从公开 HTTPS 图片 URL 下载 PNG、JPEG、WebP 或 GIF 并保存到固定工作区。不能使用 /mnt/data 本地沙箱路径。', inputSchema: { imageUrl: z.string().url(), path: z.string() },
  }, async ({ imageUrl, path: relativePath }) => {
    const source = await publicImageTarget(imageUrl); const filePath = await targetPath(relativePath, { createParents: true });
    const expectedMime = extensionMime(filePath); if (!expectedMime) throw new Error('目标文件扩展名必须为 .png/.jpg/.jpeg/.webp/.gif。');
    const bytes = await downloadImage(source, expectedMime);
    await fs.writeFile(filePath, bytes);
    return asText(`已从 URL 保存图片到 ${cleanRelativePath(relativePath)}（${bytes.length} bytes）。`);
  });
  server.registerTool('list_captured_images', {
    title: '列出已捕获聊天图片', description: '列出由本地 ChatGPT 图片桥接扩展捕获、尚未归档的图片。', inputSchema: {},
  }, async () => {
    const entries = await fs.readdir(bridgeInbox, { withFileTypes: true });
    const images = await Promise.all(entries.filter((entry) => entry.isFile() && extensionMime(entry.name)).map(async (entry) => {
      const stat = await fs.stat(path.join(bridgeInbox, entry.name)); return { fileName: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }));
    return asText(JSON.stringify({ inbox: '.chatgpt-image-inbox', images }, null, 2));
  });
  server.registerTool('save_captured_image', {
    title: '保存已捕获的聊天图片', description: '将浏览器扩展捕获的图片从收件箱移动到固定工作区中指定的路径。', inputSchema: { fileName: z.string(), path: z.string(), overwrite: z.boolean().default(false) },
  }, async ({ fileName, path: relativePath, overwrite }) => {
    if (path.basename(fileName) !== fileName || !extensionMime(fileName)) throw new Error('收件箱图片文件名无效。');
    const source = await existingPath(path.join('.chatgpt-image-inbox', fileName)); const destination = await targetPath(relativePath, { createParents: true });
    if (extensionMime(source) !== extensionMime(destination)) throw new Error('目标扩展名必须与原图片一致。');
    if (!overwrite) { try { await fs.access(destination); throw new Error('目标文件已存在，overwrite=false。'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await fs.rename(source, destination); return asText(`已保存捕获图片到 ${cleanRelativePath(relativePath)}。`);
  });
  server.registerTool('create_directory', { title: '创建目录', description: '在固定工作区创建目录。', inputSchema: { path: z.string() } }, async ({ path: relativePath }) => {
    const directory = await targetPath(relativePath, { createParents: true }); await fs.mkdir(directory, { recursive: true }); return asText(`已创建目录 ${cleanRelativePath(relativePath)}。`);
  });
  server.registerTool('move_path', { title: '移动或重命名', description: '在固定工作区内移动或重命名文件和目录。', inputSchema: { source: z.string(), destination: z.string(), overwrite: z.boolean().default(false) } }, async ({ source, destination, overwrite }) => {
    const sourcePath = await existingPath(source); const destinationPath = await targetPath(destination, { createParents: true });
    if (!overwrite) { try { await fs.access(destinationPath); throw new Error('目标已存在，overwrite=false。'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await fs.rename(sourcePath, destinationPath); return asText(`已移动 ${cleanRelativePath(source)} → ${cleanRelativePath(destination)}。`);
  });
  server.registerTool('delete_path', { title: '删除文件或目录', description: '删除固定工作区中的文件或目录，必须显式确认。', inputSchema: { path: z.string(), recursive: z.boolean().default(false), confirm: z.literal(true).describe('必须为 true 才执行删除') } }, async ({ path: relativePath, recursive }) => {
    const filePath = await existingPath(relativePath); const stat = await fs.stat(filePath);
    if (stat.isDirectory() && !recursive) { const items = await fs.readdir(filePath); if (items.length) throw new Error('非空目录需要 recursive=true。'); }
    await fs.rm(filePath, { recursive, force: false }); return asText(`已删除 ${cleanRelativePath(relativePath)}。`);
  });
  server.registerTool('get_file_info', { title: '文件信息', description: '获取文件或目录元数据。', inputSchema: pathSchema.shape }, async ({ path: relativePath }) => {
    const filePath = await existingPath(relativePath); const stat = await fs.stat(filePath); return asText(JSON.stringify({ path: cleanRelativePath(relativePath), type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString() }, null, 2));
  });
  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb', type: ['application/json', 'application/*+json'] }));
let listeningPort = port;
app.get('/health', (req, res) => {
  if (!requestAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    instanceId,
    port: listeningPort,
  });
});
app.options('/bridge/capture', (_req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-MCP-Token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }).sendStatus(204));
app.post('/bridge/capture', async (req, res) => {
  try {
    if (!requestAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const mimeType = String(req.body?.mimeType || ''); const extension = [...IMAGE_MIME_TYPES.entries()].find(([, value]) => value === mimeType)?.[0];
    if (!extension) return res.status(400).json({ error: 'Unsupported image type' });
    const bytes = safeBase64(req.body?.data); if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: 'Invalid image size' });
    const name = `chatgpt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}${extension}`;
    await fs.writeFile(path.join(bridgeInbox, name), bytes);
    res.set('Access-Control-Allow-Origin', '*').json({ ok: true, fileName: name });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.all('/mcp', async (req, res) => {
  try {
    if (!requestAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => server.close().catch(() => {}));
  } catch (error) {
    console.error('MCP request failed:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
  }
});
const httpServer = app.listen(port, host, () => {
  const address = httpServer.address();
  listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`MCP files server: http://${host}:${listeningPort}/mcp`);
  console.log(`Instance: ${instanceId} | Port: ${listeningPort} | Workspace: ${rootRealPath}`);
});




