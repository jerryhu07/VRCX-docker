# VRCX Docker Headless

这是一个面向 Docker 部署的 VRCX headless fork。后端长期运行在 Docker 容器内，浏览器只作为 UI 访问；即使浏览器页面关闭，后端也会继续保持登录状态、监听 VRChat 服务器事件、接收本地 VRChat 日志流并维护数据库。

本仓库不是官方 VRCX 发布版。上游桌面版项目见 [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)。

> **部署安全：默认仅应部署在可信内网中。若需要公网访问，必须额外配置客户端可验证的可信 TLS 证书和访问认证措施，覆盖 Web UI、API 及流式连接；不要直接将容器端口暴露到公网。**

## 运行方式

- 后端：Node.js headless server，运行在 Docker 内。
- 前端：浏览器访问容器提供的 Web UI。
- 持久化：SQLite、登录态、缓存和配置写入数据目录，默认是 `./data`。
- 日志流：Windows VRChat 客户端可运行 `vrcx-log-streamer`，把本机 VRChat 日志发送到远端 Docker 后端。
- 架构：前端不承载服务逻辑；浏览器离线不会影响后端维护登录、WebSocket、feed、friend log、game log 和 instance activity。

后端负责会话校验、重连和可恢复的登录恢复，但无法保证 VRChat 会话永不过期。服务端撤销凭据或要求重新验证时，仍需在浏览器完成登录/2FA。

## 主要功能

- Feed、好友状态与日志由后端采集，通过 SSE 推送到浏览器。关闭网页不会停止采集。
- Watch List 支持关注非好友 UID、配置轮询间隔，并以 diff 展示资料变化；mutual friends 单独获取，只按 UID 记录变化。
- 好友 mutual network 支持定时采集、变化记录和历史快照还原。隐藏好友占位保留在变化记录中，但不绘入图中。
- Player List 根据日志流维护当前房间玩家，后端自动获取玩家资料及 mutual friends，两者缓存 12 小时，支持手动刷新。
- Known connections 展示房内玩家及与他们有关联的已知好友；无关系的房外好友不显示，房内好友到房外好友的边不显示。切换到图表不会触发扫描，增量更新保留已有节点布局。图中没有连线不代表不存在好友关系，只代表 API 未提供对应关系。
- Instance Activity 按日志重建会话，区分仍在线、已离开及离开时间未知；保留手动刷新，不增加自动刷新定时器。
- 竖屏模式按视口 `height > width` 判断，正方形和横屏保留桌面布局。导航和好友栏使用抽屉，列表保持紧凑单行，超宽内容局部横向滚动；竖屏操作不覆盖共享的横屏布局设置。

## 快速开始

需要安装 Docker 和 Docker Compose。当前主要部署、验证目标为 `linux/amd64`。

```bash
git clone https://github.com/jerryhu07/VRCX-docker.git
cd VRCX-docker
cp .env.example .env
docker compose up -d --build
```

打开：

```text
http://127.0.0.1:18080/
```

首次使用在浏览器内完成 VRChat 登录和 2FA。登录态会保存在 `VRCX_DATA_DIR` 指向的数据目录中。

## 配置

`.env.example` 提供了常用配置：

```env
VRCX_HOST_PORT=18080
VRCX_DATA_DIR=./data
VRCX_LOG_STREAM_TOKEN=
VRCX_LOG_STREAM_ALLOW_TOKEN_READ=1
```

变量说明：

- `VRCX_HOST_PORT`：宿主机暴露端口，默认 `18080`。
- `VRCX_DATA_DIR`：持久化数据目录，默认 `./data`。
- `VRCX_LOG_STREAM_TOKEN`：Windows 日志 streamer 连接后端时使用的 token。留空时后端可生成或复用当前 token。
- `VRCX_LOG_STREAM_ALLOW_TOKEN_READ`：默认 `1`，允许从后端读取日志 streamer token，方便客户端配置。

`VRCX_FRIEND_REFRESH_INTERVAL_MS` 默认 `0`（禁用周期性好友全量刷新）。需要调整时，在 Compose 的 `environment` 中显式添加；仅写入 `.env` 不会自动传入容器。

不要删除或覆盖数据目录，否则 SQLite 数据库、登录态和历史日志会丢失。迁移时需要保留整个目录，具体要求见下方“数据安全与升级”。

## 常用命令

```bash
docker compose up -d --build
docker compose logs -f
docker compose ps
docker compose down
```

健康检查：

```bash
curl http://127.0.0.1:18080/healthz
```

读取日志 streamer token：

```bash
curl http://127.0.0.1:18080/headless/log-stream/token
```

## 镜像构建

当前以 `linux/amd64` 为部署和验证目标。Dockerfile 保留 arm64 分支，但不作为当前发布保证。

单平台本机构建：

```bash
docker build -t vrcx-headless:local .
```

使用 buildx 验证 amd64：

```bash
docker buildx build --platform linux/amd64 -t vrcx-headless:amd64 --load .
```

如果当前宿主机架构和目标架构不同，需要 Docker 已启用对应的 emulation/binfmt 支持。

## 数据安全与升级

`./data:/data` 是持久化绑定挂载，普通容器重建不应清空它。挂载目录更换、误删文件，以及未提交事务回滚是不同的问题，不能仅凭数据库体积变化判断数据丢失原因。

当前代码串行协调共享 SQLite 连接上的操作，隔离后端事务，阻止浏览器跨请求持有事务。关机时停止接收新请求，等待已接收的日志写入和数据库队列，再关闭 SQLite；Compose 默认提供 30 秒退出宽限期。这不替代备份，也不保证强制终止或磁盘故障时的数据恢复。

升级顺序：

1. 在服务仍运行时，通过 SQLite 在线备份 API 创建备份，并在备份副本上检查完整性。不要先停机再把备份当作事故前快照，也不要只复制正在写入的主数据库文件。
2. 构建或拉取新镜像，确认镜像可用后再替换容器，保留原数据挂载及配置。
3. 检查 `/healthz`、登录状态、日志客户端连接，以及关键表的已提交记录数量和最新时间。

迁移整个数据目录时，先完成在线数据库备份，再正常停止服务，完整复制数据目录后启动新服务。不要让两个采集后台同时写入同一个数据库。保留迁移前的备份，不要通过强制 COMMIT 来掩盖未知事务问题。

历史事故证据、结论边界和回归测试见 [SQLite 事故复盘与维护规则](docs/database-incident-2026-10.md)。

## Windows VRChat 日志 Streamer

Windows amd64 客户端不需要安装 Node.js。从 Game Log 下载包含配置的安装程序即可安装；配置默认使用 `streamer_<VRChat user ID>` 作为客户端 ID、当前浏览器的 origin 作为后端地址。下载前确认该地址能从 Windows 电脑访问，尤其不要误用另一台机器的 `127.0.0.1`。

Game Log 的设置入口可修改配置、逐项或全部恢复默认，以及确认后轮换密钥。保存配置不会自动改写已安装客户端，需重新下载并应用。轮换会立即撤销旧密钥及连接，所有客户端都要更新。

安装程序分别询问是否替换 exe、配置及重置日志断点，可以只更新其中一项；被替换文件保留备份。通过 WMI 监听 VRChat 启动，再触发当前用户的按需计划任务。该任务没有开机、登录或定时触发器，不通过常驻 streamer 等待游戏，也不由安装程序启动 VRChat。

从源码打包：

```bash
npm run build:log-streamer:win-x64
```

生成 `build/vrcx-log-streamer-win-x64.exe` 和 `build/vrcx-log-streamer-setup-win-x64.exe`。普通 Docker 构建不会自动打包 Windows 客户端；要启用网页下载，需要单独提供这两个发布文件。当前后端读取 `/app/build/html/downloads/` 下的以下文件名（日期后缀是现有下载路由约定）：

```text
vrcx-log-streamer-win-x64-20261006.exe
vrcx-log-streamer-setup-win-x64-20261006.exe
```

可将未个性化的构建产物按上述名称放入宿主机 `releases/`，在 Compose override 的该服务中增加只读挂载 `./releases:/app/build/html/downloads:ro`。后端会在下载安装程序时嵌入当前配置，不要把已经包含个人配置的安装包当作公共模板。

典型运行方式：

```powershell
.\vrcx-log-streamer-win-x64.exe --server http://SERVER_IP:18080 --token YOUR_TOKEN
```

streamer 会读取本机 VRChat 日志，把 game log、friend location、instance activity 所需事件推送到 Docker 后端。后端负责解析、入库和广播给前端；浏览器不需要在线。

历史日志默认 `backfill`，最多回看 14 天、20 个文件；也可配置 `ask` 在启动时询问补传或跳过。日志必须仍存在于 Windows 本机，补传不能恢复已删除的源文件。重置断点后，符合范围的日志可重传，后端按源文件、字节偏移和原始行去重；历史重放不应倒退当前房间状态。

个性化安装包、配置及配置备份都含密钥，不要公开分享或上传公共扫描服务。安装包尚未代码签名；原生 WMI、UAC 和安全软件兼容性需在 Windows 上验证。更多安装、升级及故障说明见 [日志客户端文档](tools/log-streamer/README.md)。

## 远端部署建议

在服务器上：

```bash
git clone https://github.com/jerryhu07/VRCX-docker.git /opt/vrcx-headless
cd /opt/vrcx-headless
cp .env.example .env
docker compose up -d --build
```

默认应部署在可信内网中，不要将容器端口直接暴露到公网。此 fork 是共享后端，不提供独立的多用户 Web 登录权限隔离；VRChat 登录不等于网页访问鉴权。若需要公网访问，必须在入口增加可信 TLS（证书应被浏览器和日志客户端信任并正确校验）和访问认证，覆盖 Web UI、API、SSE 与 WebSocket，并限制对后端端口的直连以避免绕过认证。仅启用 HTTPS 而没有认证并不足够，也不要通过关闭证书校验来绕过 TLS 错误。

反向代理需要同时支持 WebSocket upgrade 和长连接 SSE（`/headless/events`，禁用响应缓冲并设置合理超时）。日志客户端也必须能通过所配置的访问控制连接后台。`VRCX_LOG_STREAM_TOKEN` 是日志写入凭据，不是整个 Web UI 的访问密码；默认允许读取 token，更要限制后台访问。

## 故障排查

- 页面左下角显示 WebSocket 断开：先检查 `docker compose logs -f` 和 `/healthz`，确认后端仍在运行。
- 刷新页面才看到 Feed 或好友更新：检查浏览器 `/headless/events` SSE 连接、代理缓冲设置及后端到 VRChat 的连接；不要把浏览器推送连接与 VRChat pipeline 混为一谈。
- 重启后数据缺失：先保留现有数据库和备份，检查实际挂载路径、已提交记录与事务错误日志，不要清空目录、盲目重放或运行未经验证的修复 SQL。
- Instance Activity / Player List 缺数据：确认 streamer 在线、VRChat 正在运行、日志路径可读且 debug logging 已开启。状态 `unknown` 表示无法确认，不等于关闭；查看客户端错误信息。
- Known connections 缺少边：受 API 可见性和 12 小时缓存影响，可主动刷新；非好友资料、隐藏关系不一定可获取。
- 网页下载客户端返回 404：确认 Windows 发布文件已按上文路径挂载；重建后端镜像本身不会生成它们。

## 开发

使用 Node.js 24.10+、npm 11.5+，先运行 `npm ci`。以下命令只启动前端，通过代理使用已有后台，不启动第二个采集服务：

```sh
VRCX_HEADLESS_PROXY_URL=http://BACKEND_HOST:18080 npm run dev-linux -- --host 0.0.0.0 --port 9000
```

使用启动输出中的局域网地址在手机打开预览。代理地址仅是开发环境变量，不写入生产构建。手动预览中的设置与业务操作仍会作用于真实后台。

常用验证命令：

```bash
npm test
node --test headless/*.test.cjs tools/log-streamer/log-streamer.test.cjs
npm run prod-linux
docker buildx build --platform linux/amd64 -t vrcx-headless:amd64 --load .
```

浏览器预览运行后，可执行 Chromium/WebKit 回归：

```sh
npx playwright install chromium webkit
npm run test:portrait
```

可用 `PORTRAIT_BASE_URL` 指定预览地址，或用 `PORTRAIT_CHROME_CHANNEL=chrome` 测试本机 Chrome。自动浏览器回归拦截业务写操作；截图与报告保存在忽略提交的 `build/portrait-qa`、`build/portrait-report`。测试覆盖不同长宽比、旋转、导航、列表、弹窗及图表，不能替代 iOS/Android 真机键盘和系统手势检查。

核心实现入口：

- `headless/server.js`：会话、API、事件推送及日志入库。
- `headless/sqliteCoordinator.cjs`：共享 SQLite 连接的事务隔离与关机等待。
- `headless/instanceActivity.cjs`：日志会话及玩家活动重建。
- `headless/roomData.cjs`：房内资料、mutual friends 缓存及关系图数据。
- `src/services/database/gameLog.js`
- `src/services/headlessBridge.js`
- `src/views/PlayerList/components/RoomMutualNetwork.vue`
- `tools/log-streamer/log-streamer.js`
