/**
 * dsh-lan-share 核心：工作区文件局域网 HTTP 共享服务器。
 *
 * 零依赖（node:http + node:fs）。让同一局域网内的手机/平板/其他电脑
 * 通过浏览器浏览、下载、上传本机工作区文件——不需要登录 DSH。
 *
 * 安全模型：
 * - token 门禁：启动时生成随机 token；访问需带 ?token= 或 X-Token 头；
 * - 路径边界：所有路径解析后必须位于共享根（工作区）内，../ 与绝对路径越界拒绝；
 * - 只读/读写：readOnly=true 时禁用上传/删除/移动等变更操作；
 * - 请求限流：每 IP 每分钟上限（默认 120），超限 429；
 * - 敏感文件：隐藏 .git、node_modules、.env、凭据类文件。
 */

import { createServer, type Server } from 'node:http'
import { readdirSync, statSync, createReadStream, createWriteStream, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, relative, extname, basename, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface LanShareOptions {
  /** 监听端口（默认 3980）。 */
  port?: number
  /** 监听地址（默认 0.0.0.0 全局域网；收紧用 127.0.0.1）。 */
  host?: string
  /** 共享根目录（默认当前工作区）。 */
  root?: string
  /** 只读模式（默认 false；true 时禁止上传/删除/移动）。 */
  readOnly?: boolean
  /** 自定义 token（默认随机生成）。 */
  token?: string
  /** 每 IP 每分钟请求上限（默认 120）。 */
  rateLimitPerMin?: number
  /** 是否隐藏 .env / 凭据类敏感文件（默认 true）。 */
  hideSensitive?: boolean
}

export interface LanShareState {
  running: boolean
  port: number
  host: string
  root: string
  readOnly: boolean
  urls: string[]
  token: string
  lastError: string
}

export const DEFAULT_PORT = 3980
export const DEFAULT_RATE_LIMIT = 120

const SENSITIVE_NAMES = new Set(['.env', '.credentials.yaml', 'credentials.yaml', '.netrc', 'id_rsa', 'id_ed25519'])
const SENSITIVE_EXTS = new Set(['.pem', '.key', '.pfx', '.p12'])
const HIDDEN_DIRS = new Set(['node_modules', '.git', '.dsh', '__pycache__', '.venv', 'venv'])

/** 列出本机局域网 IPv4 地址。 */
export function lanIps(): string[] {
  const out: string[] = []
  const ifs = networkInterfaces()
  for (const name of Object.keys(ifs)) {
    for (const info of ifs[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address)
    }
  }
  return out
}

/** 生成随机 token。 */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

/** 校验路径位于根内；越界抛错。 */
export function resolveSafe(root: string, p: string): string {
  const abs = resolve(root, p || '.')
  const rel = relative(resolve(root), abs)
  if (rel.startsWith('..') || rel.startsWith('..' + '\\') || rel.startsWith('..' + '/')) {
    throw new Error(`路径越界: ${p}`)
  }
  return abs
}

function isSensitive(name: string, hide: boolean): boolean {
  if (!hide) return false
  return SENSITIVE_NAMES.has(name) || SENSITIVE_EXTS.has(extname(name).toLowerCase())
}

/** 列出目录（隐藏敏感/隐藏目录）。 */
export function listDir(root: string, relPath: string, hideSensitive: boolean): { name: string; type: 'dir' | 'file'; size: number }[] {
  const abs = resolveSafe(root, relPath)
  if (!statSync(abs).isDirectory()) throw new Error(`不是目录: ${relPath}`)
  const entries = readdirSync(abs, { withFileTypes: true })
  const out: { name: string; type: 'dir' | 'file'; size: number }[] = []
  for (const e of entries) {
    if (e.isDirectory() && HIDDEN_DIRS.has(e.name)) continue
    if (e.isFile() && isSensitive(e.name, hideSensitive)) continue
    let size = 0
    try {
      if (e.isFile()) size = statSync(join(abs, e.name)).size
    } catch {
      /* ignore */
    }
    out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size })
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return out
}

/** 目录统计（用于状态展示）。 */
export function countFiles(root: string, hideSensitive: boolean): { files: number; dirs: number } {
  let files = 0
  let dirs = 0
  const walk = (d: string, depth: number) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (HIDDEN_DIRS.has(e.name)) continue
        dirs++
        walk(join(d, e.name), depth + 1)
      } else if (e.isFile() && !isSensitive(e.name, hideSensitive)) {
        files++
      }
    }
  }
  walk(root, 0)
  return { files, dirs }
}

/** 上传文件（幂等：同名覆盖）。 */
export function writeUpload(root: string, relPath: string, stream: IncomingMessage): Promise<{ bytes: number }> {
  const abs = resolveSafe(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  return new Promise((resolvePromise, reject) => {
    const ws = createWriteStream(abs)
    let bytes = 0
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    stream.pipe(ws)
    ws.on('finish', () => resolvePromise({ bytes }))
    ws.on('error', (err) => reject(err))
  })
}

/** 删除文件或空目录。 */
export function removeEntry(root: string, relPath: string): void {
  const abs = resolveSafe(root, relPath)
  rmSync(abs, { recursive: true, force: false })
}

/** 移动/重命名。 */
export function moveEntry(root: string, from: string, to: string): void {
  const absFrom = resolveSafe(root, from)
  const absTo = resolveSafe(root, to)
  if (absFrom === absTo) return
  renameSync(absFrom, absTo)
}

/**
 * 创建共享服务器。返回 { server, urls, token }。
 * 用 `state` 回调报告运行状态变化（可选）。
 */
export function createShareServer(
  opts: LanShareOptions,
  state?: (s: Partial<LanShareState>) => void,
): { server: Server; urls: string[]; token: string } {
  const port = opts.port ?? DEFAULT_PORT
  const host = opts.host ?? '0.0.0.0'
  const root = resolve(opts.root ?? process.cwd())
  const readOnly = opts.readOnly ?? false
  const token = opts.token ?? randomToken()
  const rateLimit = opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT
  const hideSensitive = opts.hideSensitive ?? true

  const rateMap = new Map<string, number[]>()
  const urls = lanIps().map((ip) => `http://${ip}:${port}/?token=${token}`)

  const server = createServer((req, res) => {
    // CORS（同源浏览器不需要，但允许命令行/脚本访问）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 限流
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    const now = Date.now()
    const window = (rateMap.get(ip) || []).filter((t) => now - t < 60_000)
    if (window.length >= rateLimit) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' })
      res.end('rate limited')
      return
    }
    window.push(now)
    rateMap.set(ip, window)

    // token 校验
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const qToken = url.searchParams.get('token')
    const hToken = req.headers['x-token']
    const ok = qToken === token || hToken === token
    if (!ok) {
      // 首页给输入框，其余 API 直接 401
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(401, { 'Content-Type': 'text/html' })
        res.end(authPage())
        return
      }
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('unauthorized')
      return
    }

    try {
      handle(req, res, url, root, readOnly, hideSensitive)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end(`error: ${msg}`)
    }
  })

  server.on('error', (err: Error) => {
    state?.({ running: false, lastError: err.message })
  })

  return { server, urls, token }
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
  readOnly: boolean,
  hideSensitive: boolean,
): void {
  const p = url.pathname

  // 首页（浏览器界面）
  if (p === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(indexHtml(readOnly))
    return
  }

  // 列出目录
  if (p === '/api/list' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '.'
    const entries = listDir(root, rel, hideSensitive)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path: rel, entries }))
    return
  }

  // 下载文件
  if (p === '/api/download' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || ''
    if (!rel) throw new Error('缺少 path 参数')
    const abs = resolveSafe(root, rel)
    if (!statSync(abs).isFile()) throw new Error('不是文件')
    const name = basename(abs)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    })
    createReadStream(abs).pipe(res)
    return
  }

  // 上传（读写模式）
  if (p === '/api/upload' && req.method === 'POST') {
    if (readOnly) throw new Error('只读模式：禁止上传')
    const rel = url.searchParams.get('path') || ''
    if (!rel) throw new Error('缺少 path 参数')
    const abs = resolveSafe(root, rel)
    if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error('目标已存在且为目录')
    mkdirSync(dirname(abs), { recursive: true })
    const ws = createWriteStream(abs)
    req.pipe(ws)
    ws.on('finish', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: rel }))
    })
    ws.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`upload error: ${err.message}`)
    })
    return
  }

  // 删除（读写模式）
  if (p === '/api/delete' && req.method === 'DELETE') {
    if (readOnly) throw new Error('只读模式：禁止删除')
    const rel = url.searchParams.get('path') || ''
    removeEntry(root, rel)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // 移动（读写模式）
  if (p === '/api/move' && req.method === 'POST') {
    if (readOnly) throw new Error('只读模式：禁止移动')
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    moveEntry(root, from, to)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
}

function authPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-lan-share · 需要访问令牌</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#0f172a;color:#e2e8f0}form{background:#1e293b;padding:2rem;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4)}input{display:block;width:100%;padding:.6rem;margin:.6rem 0 1rem;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0}button{padding:.6rem 1.2rem;border:none;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;font-size:1rem}</style>
</head><body><form method="get" action="/">
<h2>🔒 dsh-lan-share</h2>
<p style="color:#94a3b8">输入访问令牌（在 DSH 中运行 lan_share_status 查看）</p>
<input type="password" name="token" placeholder="访问令牌" autofocus>
<button type="submit">进入</button>
</form></body></html>`
}

function indexHtml(readOnly: boolean): string {
  const modeBadge = readOnly ? '🛡️ 只读模式' : '✏️ 读写模式'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-lan-share · 工作区文件</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:1rem;max-width:960px;margin:0 auto}
header{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem}
h1{font-size:1.25rem;margin:0}
.badge{font-size:.75rem;background:#1e293b;border:1px solid #334155;padding:.2rem .5rem;border-radius:999px;color:#94a3b8}
.crumbs{margin-bottom:.75rem;font-size:.9rem;display:flex;gap:.25rem;flex-wrap:wrap;align-items:center}
.crumbs a{color:#60a5fa;text-decoration:none}
.crumbs a:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden}
th,td{padding:.6rem .75rem;text-align:left;border-bottom:1px solid #334155;font-size:.9rem}
th{background:#111827;color:#94a3b8;font-weight:600}
tr:hover td{background:#24344d}
a{color:#e2e8f0;text-decoration:none}
a.file{color:#93c5fd}
.size{color:#94a3b8;text-align:right;font-variant-numeric:tabular-nums}
.up{color:#34d399;cursor:pointer}
.del{color:#f87171;cursor:pointer;margin-left:.5rem}
.upload-zone{margin:1rem 0;border:2px dashed #475569;border-radius:8px;padding:1.25rem;text-align:center;color:#94a3b8;cursor:pointer}
.upload-zone.drag{background:#1e3a5f;border-color:#3b82f6}
input[type=file]{display:none}
.btn{padding:.45rem .9rem;border:none;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;font-size:.85rem}
.empty{color:#64748b;text-align:center;padding:2rem}
@media(max-width:600px){th:nth-child(3),td:nth-child(3){display:none}}
</style></head><body>
<header><h1>📁 工作区文件</h1><span class="badge">${modeBadge}</span></header>
<div class="crumbs" id="crumbs"></div>
${readOnly ? '' : `<div class="upload-zone" id="zone">点击或拖拽文件到此处上传到当前目录</div><input type="file" id="file" multiple>`}
<table><thead><tr><th>名称</th><th>大小</th><th>操作</th></tr></thead><tbody id="tbody"></tbody></table>
<div class="empty" id="empty" style="display:none">（空目录）</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const READONLY = ${readOnly};
let cur = '.';
function q(p){return '?path='+encodeURIComponent(p)+(token?'&token='+encodeURIComponent(token):'')}
async function load(dir){
  const r = await fetch('/api/list'+q(dir));
  if(r.status===401){location.href='/';return}
  const data = await r.json();
  cur = data.path;
  renderCrumbs(data.path);
  const tb = document.getElementById('tbody'); tb.innerHTML='';
  document.getElementById('empty').style.display = data.entries.length?'none':'block';
  for(const e of data.entries){
    const tr=document.createElement('tr');
    const nameCell=document.createElement('td');
    if(e.type==='dir'){const a=document.createElement('a');a.textContent='📂 '+e.name;a.href='javascript:void(0)';a.onclick=()=>load(join(cur,e.name));nameCell.appendChild(a)}
    else{const a=document.createElement('a');a.className='file';a.textContent='📄 '+e.name;a.href='/api/download'+q(join(cur,e.name));nameCell.appendChild(a)}
    tr.appendChild(nameCell);
    const sizeCell=document.createElement('td');sizeCell.className='size';sizeCell.textContent=e.type==='dir'?'—':fmt(e.size);tr.appendChild(sizeCell);
    const opCell=document.createElement('td');
    if(e.type==='file'&&!READONLY){
      const del=document.createElement('span');del.className='del';del.textContent='删除';del.onclick=async()=>{if(confirm('删除 '+e.name+'？')){await fetch('/api/delete'+q(join(cur,e.name)),{method:'DELETE'});load(cur)}};opCell.appendChild(del)
    }
    tr.appendChild(opCell);
    tb.appendChild(tr);
  }
}
function join(a,b){return (a==='.'?'':a)+'/'+b}
function renderCrumbs(p){
  const el=document.getElementById('crumbs');el.innerHTML='';
  const parts=(p==='.'?'':p).split('/').filter(Boolean);
  const a=document.createElement('a');a.textContent='🏠 根目录';a.href='javascript:void(0)';a.onclick=()=>load('.');el.appendChild(a);
  let acc='';
  for(const pt of parts){acc=acc?acc+'/'+pt:pt;el.appendChild(document.createTextNode(' / '));const c=document.createElement('a');c.textContent=pt;c.href='javascript:void(0)';c.onclick=()=>load(acc);el.appendChild(c)}
}
function fmt(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB'}
if(!READONLY){
  const zone=document.getElementById('zone'),file=document.getElementById('file');
  zone.onclick=()=>file.click();
  zone.ondragover=e=>{e.preventDefault();zone.classList.add('drag')};
  zone.ondragleave=()=>zone.classList.remove('drag');
  zone.ondrop=e=>{e.preventDefault();zone.classList.remove('drag');upload(e.dataTransfer.files)};
  file.onchange=()=>upload(file.files);
}
async function upload(files){
  for(const f of files){
    const path=join(cur,f.name);
    const fd=new FormData();fd.append('file',f);
    // 用 fetch + URL path 传递目录（FormData 只传内容）
    const r=await fetch('/api/upload?path='+encodeURIComponent(path)+(token?'&token='+encodeURIComponent(token):''),{method:'POST',body:f});
    if(!r.ok)alert('上传失败: '+path);
  }
  load(cur);
}
load('.');
</script></body></html>`
}
