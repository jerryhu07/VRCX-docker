# VRCX Docker Headless

这是一个面向 Docker 部署的 VRCX headless fork。后端长期运行在 Docker 容器内，浏览器只作为 UI 访问；即使浏览器页面关闭，后端也会继续保持登录状态、监听 VRChat 服务器事件、接收本地 VRChat 日志流并维护数据库。

本仓库不是官方 VRCX 发布版。上游桌面版项目见 [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)。

## 运行方式

- 后端：Node.js headless server，运行在 Docker 内。
- 前端：浏览器访问容器提供的 Web UI。
- 持久化：SQLite、登录态、缓存和配置写入数据目录，默认是 `./data`。
- 日志流：Windows VRChat 客户端可运行 `vrcx-log-streamer`，把本机 VRChat 日志发送到远端 Docker 后端。
- 架构：前端不承载服务逻辑；浏览器离线不会影响后端维护登录、WebSocket、feed、friend log、game log 和 instance activity。

## 快速开始

需要安装 Docker 和 Docker Compose。

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

不要删除或覆盖数据目录，否则 SQLite 数据库、登录态和历史日志会丢失。迁移服务器时，把该目录一起复制过去。

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

## 多架构构建

本项目应能在 `linux/amd64` 和 `linux/arm64` 上构建。

单平台本机构建：

```bash
docker build -t vrcx-headless:local .
```

使用 buildx 验证 amd64：

```bash
docker buildx build --platform linux/amd64 -t vrcx-headless:amd64 --load .
```

使用 buildx 验证 arm64：

```bash
docker buildx build --platform linux/arm64 -t vrcx-headless:arm64 --load .
```

如果当前宿主机架构和目标架构不同，需要 Docker 已启用对应的 emulation/binfmt 支持。

## Windows VRChat 日志 Streamer

Windows 客户端不需要安装 Node.js。可以使用打包后的 `vrcx-log-streamer-win-x64.exe`，也可以从源码重新打包：

```bash
npm run build:log-streamer:win-x64
```

典型运行方式：

```powershell
.\vrcx-log-streamer-win-x64.exe --server http://SERVER_IP:18080 --token YOUR_TOKEN
```

streamer 会读取本机 VRChat 日志，把 game log、friend location、instance activity 所需事件推送到 Docker 后端。后端负责解析、入库和广播给前端；浏览器不需要在线。

历史日志处理是防御性的：启动时可选择补传历史日志或跳过，避免把明显异常或过旧的数据误写入当前活动记录。

## 远端部署建议

在服务器上：

```bash
git clone https://github.com/jerryhu07/VRCX-docker.git /opt/vrcx-headless
cd /opt/vrcx-headless
cp .env.example .env
docker compose up -d --build
```

如果部署在公网，建议放在 HTTPS 反向代理后面，并限制访问来源。`VRCX_LOG_STREAM_TOKEN` 等同于写入日志数据的凭据，不要公开泄露。

## 故障排查

- 页面左下角显示 WebSocket 断开：先检查 `docker compose logs -f` 和 `/healthz`，确认后端仍在运行。
- 刷新页面才看到 feed 更新：检查浏览器是否能访问后端 WebSocket，反向代理需要支持 WebSocket upgrade。
- 重启后数据丢失：确认 `VRCX_DATA_DIR` 已挂载到宿主机持久化目录。
- instance activity 缺数据：确认 Windows streamer 正在运行，且 VRChat 日志路径可读。

## 开发

常用验证命令：

```bash
npm test
npm run prod-linux
docker compose build
```

与 instance activity、game log 相关的核心逻辑在：

- `src/services/database/gameLog.js`
- `src/services/headlessBridge.js`
- `headless/server.js`
- `tools/log-streamer/log-streamer.js`
