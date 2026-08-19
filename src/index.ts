/**
 * dsh-lan-share 插件入口。
 *
 * 工作区文件局域网 HTTP 共享：手机/平板/同网电脑用浏览器直接浏览、下载、
 * 上传本机工作区文件——不需要登录 DSH。零依赖（node:http）。
 *
 * 工具：
 *   - lan_share_status  查看共享状态（端口/地址/token/只读/统计）
 *   - lan_share_start   启动共享（可指定端口/token/只读模式）
 *   - lan_share_stop    停止共享
 *
 * settings 命名空间 `lan-share`（可选）：
 *   port / host / readOnly / rateLimitPerMin / hideSensitive
 *
 * 安全：token 门禁；路径边界（工作区内）；只读模式禁变更；每 IP 限流；
 * 隐藏 .env / 密钥 / node_modules / .git。
 *
 * 接入方式：cordis.yml 追加
 *   - id: tool-lan-share
 *     name: 'dsh-lan-share'
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { resolve, relative } from 'node:path'
import {
  createShareServer,
  lanIps,
  countFiles,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT,
  type LanShareState,
  type LanShareOptions,
} from './lan-share-core.js'

export const name = 'dsh-lan-share'
export const inject = ['tools']

const NS = settingsNamespace('lan-share')

interface LanShareSettings {
  port: number
  host: string
  readOnly: boolean
  rateLimitPerMin: number
  hideSensitive: boolean
}

const DEFAULT_SETTINGS: LanShareSettings = {
  port: DEFAULT_PORT,
  host: '0.0.0.0',
  readOnly: false,
  rateLimitPerMin: DEFAULT_RATE_LIMIT,
  hideSensitive: true,
}

const LanShareSettingsSchema = Schema.object({
  port: Schema.number().min(1024).max(65535).default(DEFAULT_PORT).description('监听端口'),
  host: Schema.string().default('0.0.0.0').description('监听地址（0.0.0.0=全局域网；127.0.0.1=仅本机）'),
  readOnly: Schema.boolean().default(false).description('只读模式（禁止上传/删除/移动）'),
  rateLimitPerMin: Schema.number().min(1).max(10000).default(DEFAULT_RATE_LIMIT).description('每 IP 每分钟请求上限'),
  hideSensitive: Schema.boolean().default(true).description('隐藏 .env/密钥/凭据类文件'),
})

export function apply(ctx: Context): void {
  // settings（可选）
  const getSettings = (): LanShareSettings => {
    try {
      const scope = ctx.settings?.get(NS)
      if (scope && typeof scope === 'object') {
        return { ...DEFAULT_SETTINGS, ...(scope as Partial<LanShareSettings>) }
      }
    } catch {
      /* 回退默认 */
    }
    return DEFAULT_SETTINGS
  }
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(NS, LanShareSettingsSchema, { applies: 'live' })
    })
  } catch {
    /* settings 不可用 */
  }

  // 共享服务器状态
  let server: ReturnType<typeof createShareServer> | null = null
  let currentRoot = process.cwd()
  let currentReadOnly = DEFAULT_SETTINGS.readOnly
  let lastError = ''

  const workspaceOf = (exec: { agent?: { session?: { header?: { cwd?: string } } } }): string =>
    exec.agent?.session?.header?.cwd || process.cwd()

  const stop = () => {
    if (server) {
      try {
        server.server.close()
      } catch {
        /* ignore */
      }
      server = null
    }
  }
  ctx.effect(() => () => {
    stop()
  })

  const stateOf = (): LanShareState => {
    const urls = server ? server.urls : lanIps().map((ip) => `http://${ip}:${DEFAULT_PORT}/`)
    return {
      running: server !== null,
      port: DEFAULT_PORT,
      host: '0.0.0.0',
      root: currentRoot,
      readOnly: currentReadOnly,
      urls,
      token: server ? server.token : '',
      lastError,
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'lan_share_status',
      description:
        'Show the LAN file-share status: running or not, root directory, read-only mode, access URLs ' +
        '(with token), and file/dir counts. Use to get the address to open on a phone or other computer.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async () => {
        const s = stateOf()
        const { files, dirs } = countFiles(currentRoot, getSettings().hideSensitive)
        return JSON.stringify({ ...s, fileCount: files, dirCount: dirs }, null, 1)
      },
      timeoutMs: 3000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lan_share_start',
      description:
        'Start the LAN file share server so devices on the same network can browse/download/upload ' +
        'the workspace via a browser (http://<LAN-IP>:port/?token=...). All paths stay inside the ' +
        'workspace; readOnly=true disables upload/delete/move. Returns the access URLs and token.',
      parameters: {
        port: {
          type: 'integer',
          description: `Listen port (default ${DEFAULT_PORT}).`,
        },
        readOnly: {
          type: 'boolean',
          description: 'Read-only mode: browse/download only, no upload/delete/move (default from settings).',
        },
        token: {
          type: 'string',
          description: 'Custom access token (default: random).',
        },
        dir: {
          type: 'string',
          description: 'Subdirectory of the workspace to share (default: workspace root).',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const settings = getSettings()
        stop()
        const ws = workspaceOf(exec)
        currentRoot = args.dir ? ws : ws
        // dir 是工作区子目录
        const opts: LanShareOptions = {
          port: typeof args.port === 'number' ? args.port : settings.port,
          host: settings.host,
          root: typeof args.dir === 'string' && args.dir ? joinSafe(ws, args.dir) : ws,
          readOnly: typeof args.readOnly === 'boolean' ? args.readOnly : settings.readOnly,
          token: typeof args.token === 'string' && args.token ? args.token : undefined,
          rateLimitPerMin: settings.rateLimitPerMin,
          hideSensitive: settings.hideSensitive,
        }
        currentReadOnly = opts.readOnly!
        currentRoot = opts.root!
        try {
          server = createShareServer(opts, (s) => {
            if (s.lastError !== undefined) lastError = s.lastError
          })
          await new Promise<void>((resolvePromise, reject) => {
            server!.server.once('error', reject)
            server!.server.listen(opts.port, opts.host, () => {
              server!.server.removeListener('error', reject)
              resolvePromise()
            })
          })
          return JSON.stringify({ ok: true, ...stateOf() }, null, 1)
        } catch (err) {
          server = null
          lastError = err instanceof Error ? err.message : String(err)
          throw new Error(`lan_share_start 失败: ${lastError}`)
        }
      },
      timeoutMs: 5000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lan_share_stop',
      description: 'Stop the LAN file share server (if running).',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async () => {
        const wasRunning = server !== null
        stop()
        return JSON.stringify({ ok: true, wasRunning })
      },
      timeoutMs: 3000,
    }),
  )
}

/** 子目录安全拼接（工作区内）。 */
function joinSafe(root: string, sub: string): string {
  const abs = resolve(root, sub)
  const rel = relative(resolve(root), abs)
  if (rel.startsWith('..') || rel.startsWith('..' + '\\') || rel.startsWith('..' + '/')) {
    throw new Error(`目录越界: ${sub}`)
  }
  return abs
}
