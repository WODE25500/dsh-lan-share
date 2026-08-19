# dsh-lan-share

DeepSeek Harness 的**局域网文件共享**插件 —— 把工作区通过 HTTP 共享到同一局域网：手机 / 平板 / 其他电脑用**浏览器**直接浏览、下载、上传文件，**不需要登录 DSH**。零依赖（node:http）。

> **和现有方案的区别**：
> - `dsh-lan-gate` / `dsh-plugin-remote-access`：代理整个 DSH **网页**（要登录/批准设备）；
> - `dsh-ssh`：**远程服务器**上的执行与 SFTP；
> - `dsh-webfile`：**S3/FTP** 等远程存储；
> - 本插件：**本机工作区文件的纯局域网 HTTP 共享**——临时传个文件给手机、让同事浏览器拉取产物，开箱即用。

## 注册工具

| 工具 | 功能 |
| --- | --- |
| `lan_share_start` | 启动共享服务器（可指定端口/token/只读模式/子目录），返回访问地址 |
| `lan_share_status` | 查看共享状态（运行中/根目录/只读/URL/token/文件统计） |
| `lan_share_stop` | 停止共享 |

## 快速开始

```
lan_share_start → {
  "ok": true,
  "running": true,
  "port": 3980,
  "root": "F:/work",
  "readOnly": false,
  "urls": ["http://192.168.1.5:3980/?token=9f2c...", "..."],
  "token": "9f2c..."
}
```

手机/其他电脑浏览器打开 `http://192.168.1.5:3980/?token=9f2c...` 即可：

- 📂 浏览目录树（面包屑导航）
- 📄 点击文件名下载
- ✏️ 读写模式：拖拽/点击上传到当前目录、删除文件
- 🛡️ 只读模式：仅浏览 + 下载

## 安全模型

- **token 门禁**：启动时生成随机 token；访问需带 `?token=` 或 `X-Token` 头；无 token 访问首页显示输入框；
- **路径边界**：所有路径解析后必须位于共享根内，`../` 与绝对路径越界拒绝（HTTP 400）；
- **只读模式**：`readOnly: true` 时上传/删除/移动全部拒绝；
- **限流**：每 IP 每分钟默认 120 请求，超限 429；
- **敏感文件隐藏**：默认隐藏 `.env`、凭据类（`credentials.yaml`、`.netrc`）、密钥（`*.pem/*.key/*.pfx`）、`node_modules`、`.git` 等；
- **监听地址可收紧**：settings 里 `host: 127.0.0.1` 可只让本机代理接入。

## 安装

```yaml
# cordis.yml / dsh.profile 引用
plugins:
  - id: tool-lan-share
    name: 'dsh-lan-share'
```

或本地路径：

```yaml
plugins:
  ./src/index.ts: {}
```

## settings（可选）

命名空间 `lan-share`：

```yaml
lan-share:
  port: 3980            # 监听端口
  host: 0.0.0.0         # 0.0.0.0=全局域网；127.0.0.1=仅本机
  readOnly: false       # 默认只读模式
  rateLimitPerMin: 120  # 每 IP 限流
  hideSensitive: true   # 隐藏敏感文件
```

## 开发

```sh
npm install
npm run check   # typecheck + test + build
```

- Node 要求：`^22.19.0 || >=24.0.0`。
- 核心在 `src/lan-share-core.ts`（纯函数 + HTTP 处理，可单测），插件入口 `src/index.ts`。
- 测试覆盖：路径越界、token 门禁（query/header/错误 token）、敏感文件隐藏、列表/下载/上传/删除/移动、只读模式拒绝、目录排序。

## 许可

MIT
