# 14 — VPS Deployment

在 VPS / 云虚拟机上以**单机自托管**方式部署 raven。目标是稳定运行 proxy (`:7024`) + dashboard (`:7023`)，使用反向代理暴露 HTTPS 域名，并通过 systemd 做进程守护。

> **定位提醒**：raven 是研究性、个人使用项目；推荐部署到单台 Ubuntu VM，仅供自己使用，不按多租户服务设计。

本文档提供两种反向代理方案：
- **方案 A: Nginx + Let's Encrypt** — 传统方案，需要开放 80/443 端口
- **方案 B: Cloudflare Tunnel** — 零端口暴露，自动 HTTPS，推荐

---

## ⚠️ 远程部署安全须知

在 VPS 上部署时，务必注意以下两点：

### 1. Dashboard 必须启用 Google OAuth

**不要使用 Local 模式**。Local 模式会跳过所有认证，任何人访问 dashboard URL 都能直接查看统计数据、管理 API Key、修改设置。

远程部署时必须配置 Google OAuth：

```bash
# /etc/raven/dashboard.env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
NEXTAUTH_SECRET=<openssl rand -base64 32>
ALLOWED_EMAILS=you@example.com  # 限制可登录的邮箱
```

### 2. 建议启用 IP 白名单

Proxy 支持 IP 白名单功能，可以限制只有特定 IP 范围能够访问 AI API 端点。在 Dashboard Settings 页面启用：

- **IP Whitelist** → 开启
- 添加你的客户端 IP（单个 IP、CIDR 如 `192.168.1.0/24`、或 IP 范围如 `10.0.0.1-10.0.0.100`）
- 如果前端有 Nginx 反向代理，启用 **Trust Proxy** 以读取 `X-Forwarded-For` 头

即使有 API Key 保护，IP 白名单也是一道额外的防线，防止 key 泄露后被滥用。

### 3. Cloudflare WAF IP 限制（使用 Tunnel 方案时）

如果使用 Cloudflare Tunnel 方案，可以在 Cloudflare WAF 层添加 IP 限制，实现双重防护：

1. 进入 Cloudflare Dashboard → 你的域名 → Security → WAF → Custom rules
2. 创建规则，Expression 填入：

```
(http.host in {"raven-api.example.com" "raven.example.com"}) and not (ip.src in {你的IP/24 另一个IP/32})
```

3. Action 选择 **Block**

这条规则的含义：匹配 raven 域名 + IP 不在白名单 → 拦截。其他子域名不受影响。

> **注意**：如果你的网络出口 IP 不固定，可以用较宽的 CIDR（如 `/23` 覆盖 512 个 IP）。多个 IP 段用空格分隔。

---

## 0. 部署拓扑

推荐使用两个域名（也可以用不同 path，但双域名更清晰）：

- `raven-api.example.com` → proxy → `127.0.0.1:7024`
- `raven.example.com` → dashboard → `127.0.0.1:7023`

### 方案 A: Nginx + Let's Encrypt

公网开放端口：

- `22/tcp`（SSH，建议限制来源 IP）
- `80/tcp`（签证书 / HTTP 跳转）
- `443/tcp`（HTTPS）

不要直接向公网开放 `7023` 和 `7024`。

### 方案 B: Cloudflare Tunnel（推荐）

公网仅开放：

- `22/tcp`（SSH，建议限制来源 IP）

Cloudflare Tunnel 通过出站连接建立隧道，无需开放任何入站端口给 HTTP 流量。优势：

- 零端口暴露 — VPS 防火墙只需开 SSH
- 自动 HTTPS — Cloudflare 边缘自动处理证书
- 内置 DDoS 防护 — Cloudflare 网络过滤恶意流量
- 简化运维 — 无需管理 Nginx 和 certbot

---

## 1. 准备 VPS

### 推荐规格

- OS: Ubuntu 24.04 LTS / Debian 12（或其他现代 Linux 发行版）
- CPU/RAM: 1 vCPU / 1 GB 足够（Raven 实际内存占用约 100-150MB）
- Disk: SSD，确保数据目录持久化

### 防火墙配置

**方案 A (Nginx)**：云平台安全组仅允许入站 22、80、443

**方案 B (Tunnel)**：云平台安全组仅允许入站 22

VM 内配合 UFW：

```bash
# 方案 A
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# 方案 B（仅 SSH）
sudo ufw allow OpenSSH
sudo ufw enable
```

---

## 2. 安装系统依赖

```bash
sudo apt update
sudo apt install -y curl unzip git
curl -fsSL https://bun.sh/install | bash
```

如果使用**方案 A (Nginx)**，还需安装：

```bash
sudo apt install -y nginx
```

如果使用**方案 B (Cloudflare Tunnel)**，安装 cloudflared：

```bash
# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-archive-keyring.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared
```

重新登录 shell，或执行：

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

确认版本：

```bash
bun --version
git --version
```

> 本仓库是 **bun workspace**。不要在 VM 上运行 `npm install` 或 `pnpm install`。

---

## 3. 获取代码并安装依赖

建议创建专用用户运行服务，并让该用户拥有部署目录：

```bash
sudo useradd --create-home --shell /bin/bash raven
sudo mkdir -p /srv
sudo chown raven:raven /srv
curl -fsSL https://bun.sh/install -o /tmp/install-bun.sh
chmod 755 /tmp/install-bun.sh
# 可先审阅 /tmp/install-bun.sh，再执行
sudo -u raven -H bash /tmp/install-bun.sh
sudo -u raven -H bash -lc "
  export BUN_INSTALL=/home/raven/.bun
  export PATH=\$BUN_INSTALL/bin:\$PATH
  cd /srv &&
  git clone https://github.com/imink/raven.git &&
  cd /srv/raven &&
  bun install
"
```

如果你已经切换到 `raven` 用户，也可以直接将仓库放到 `/home/raven/raven`；核心要求是：

- repo 在持久化目录下
- 运行用户对 repo 有写权限
- 数据目录（默认在 `~/.config/raven` 和 `~/.local/share/raven`）有持久化存储

---

## 4. 配置环境变量

建议把生产环境文件放在 repo 外，再由 systemd 引用，例如：

- `/etc/raven/proxy.env`
- `/etc/raven/dashboard.env`

```bash
sudo mkdir -p /etc/raven
sudo chmod 700 /etc/raven
```

### Proxy: `/etc/raven/proxy.env`

```bash
RAVEN_PORT=7024
RAVEN_API_KEY=replace-with-a-long-random-secret
RAVEN_INTERNAL_KEY=replace-with-another-long-random-secret
RAVEN_CONFIG_DIR=/srv/raven/config
RAVEN_DATA_DIR=/srv/raven/data
RAVEN_LOG_LEVEL=info
RAVEN_BASE_URL=https://raven-api.example.com
```

说明：

- 密钥可用 `openssl rand -base64 32` 生成
- `RAVEN_API_KEY`：给 Claude Code / Cursor 等 AI API 客户端使用
- `RAVEN_INTERNAL_KEY`：dashboard 管理接口与日志流使用
- `RAVEN_CONFIG_DIR`：配置目录（存储 `github_token`）
- `RAVEN_DATA_DIR`：数据目录（存储 `raven.db`）
- `RAVEN_BASE_URL`：必须是 proxy 的**公开 HTTPS 地址**

### Dashboard: `/etc/raven/dashboard.env`

如果 dashboard 仅自己访问，也建议仍然走 HTTPS 反向代理：

```bash
RAVEN_PROXY_URL=http://127.0.0.1:7024
RAVEN_INTERNAL_KEY=replace-with-another-long-random-secret
NEXTAUTH_URL=https://raven.example.com
USE_SECURE_COOKIES=true
```

如果 dashboard 会暴露到公网，启用 Google OAuth：

```bash
RAVEN_PROXY_URL=http://127.0.0.1:7024
RAVEN_INTERNAL_KEY=replace-with-another-long-random-secret
NEXTAUTH_URL=https://raven.example.com
NEXTAUTH_SECRET=replace-with-openssl-rand-base64-32
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
ALLOWED_EMAILS=you@example.com
USE_SECURE_COOKIES=true
```

Google Cloud Console 中的 redirect URI 配置为：

```text
https://raven.example.com/api/auth/callback/google
```

建议权限：

```bash
sudo chown -R root:root /etc/raven
sudo chmod 600 /etc/raven/*.env
```

---

## 5. 首次构建

dashboard 生产模式需要先 build。**必须在 build 时加载 dashboard 环境变量**，因为 Next.js 会在构建期间将 `GOOGLE_CLIENT_ID`、`NEXTAUTH_SECRET` 等变量静态嵌入产物。如果不加载环境变量直接 build，dashboard 会以 Local mode 构建，导致登录页面卡在 "redirecting" 无法跳转 Google OAuth。

**推荐方式**：使用 `bun run start`，它会自动执行 build 再启动服务：

```bash
cd /srv/raven
sudo -u raven bash -c 'export BUN_INSTALL=/home/raven/.bun && export PATH=$BUN_INSTALL/bin:$PATH && export $(cat /etc/raven/dashboard.env | xargs) && bun run start'
```

如果只需单独构建 dashboard（不启动服务）：

```bash
cd /srv/raven
sudo -u raven bash -c 'export BUN_INSTALL=/home/raven/.bun && export PATH=$BUN_INSTALL/bin:$PATH && export $(cat /etc/raven/dashboard.env | xargs) && bun run build'
```

proxy 直接使用 `start` 脚本即可，无需单独 build。

---

## 6. 首次 GitHub Device Flow 授权

proxy 第一次启动时会输出 GitHub Device Flow 验证码。首次部署建议**先手工启动一次 proxy**，确认授权成功后再交给 systemd。

```bash
cd /srv/raven
set -a
. /etc/raven/proxy.env
set +a
bun run --filter '@raven/proxy' start
```

终端会显示类似：

```text
Please enter the code "ABCD-1234" in https://github.com/login/device/code
```

操作：

1. 打开浏览器访问 `https://github.com/login/device/code`
2. 输入验证码
3. 授权 raven
4. 确认 `/srv/raven/data/github_token` 已生成

完成后停止前台进程，改由 systemd 托管。

---

## 7. systemd 服务

以下示例假设：

- 仓库路径：`/srv/raven`
- 运行用户：`raven`
- Bun 安装在：`/home/raven/.bun/bin/bun`

如果实际路径不同，请替换。

`PATH` 需要在两个 unit 中保持一致；如果你的 Bun 安装位置不是 `/home/raven/.bun/bin/bun`，请同时修改两个服务文件中的路径。

### `/etc/systemd/system/raven-proxy.service`

```ini
[Unit]
Description=Raven Proxy
After=network.target

[Service]
Type=simple
User=raven
Group=raven
WorkingDirectory=/srv/raven
EnvironmentFile=/etc/raven/proxy.env
Environment=PATH=/home/raven/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/raven/.bun/bin/bun run --filter @raven/proxy start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/raven-dashboard.service`

```ini
[Unit]
Description=Raven Dashboard
After=network.target raven-proxy.service
Requires=raven-proxy.service

[Service]
Type=simple
User=raven
Group=raven
WorkingDirectory=/srv/raven
EnvironmentFile=/etc/raven/dashboard.env
Environment=PATH=/home/raven/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/raven/.bun/bin/bun run --filter dashboard start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now raven-proxy.service
sudo systemctl enable --now raven-dashboard.service
```

查看状态：

```bash
sudo systemctl status raven-proxy.service
sudo systemctl status raven-dashboard.service
sudo journalctl -u raven-proxy.service -f
sudo journalctl -u raven-dashboard.service -f
```

---

## 8. 反向代理

选择下面其中一种方案。

### 方案 A: Nginx + Let's Encrypt

安装证书最简单的方式通常是 Nginx + Let's Encrypt（例如 certbot）。

先安装 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
```

#### API: `/etc/nginx/sites-available/raven-api`

```nginx
server {
    listen 80;
    server_name raven-api.example.com;

    location / {
        proxy_pass http://127.0.0.1:7024;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
```

#### Dashboard: `/etc/nginx/sites-available/raven-dashboard`

```nginx
server {
    listen 80;
    server_name raven.example.com;

    location / {
        proxy_pass http://127.0.0.1:7023;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

启用站点：

```bash
sudo ln -s /etc/nginx/sites-available/raven-api /etc/nginx/sites-enabled/raven-api
sudo ln -s /etc/nginx/sites-available/raven-dashboard /etc/nginx/sites-enabled/raven-dashboard
sudo nginx -t
sudo systemctl reload nginx
```

签发证书：

```bash
sudo certbot --nginx -d raven-api.example.com -d raven.example.com
```

签发证书后，确保 HTTP 自动跳转 HTTPS，并同步更新：

- `RAVEN_BASE_URL=https://raven-api.example.com`
- `NEXTAUTH_URL=https://raven.example.com`
- `USE_SECURE_COOKIES=true`

### 方案 B: Cloudflare Tunnel（推荐）

Cloudflare Tunnel 通过出站连接建立加密隧道，无需开放任何入站端口，无需管理证书。

#### 1) 登录 Cloudflare

```bash
cloudflared tunnel login
```

会输出一个 URL，在浏览器打开并选择你的域名授权。授权成功后 cert 会保存到 `~/.cloudflared/cert.pem`。

#### 2) 创建 Tunnel

```bash
cloudflared tunnel create raven
```

记下输出的 Tunnel ID（形如 `89a016b0-24cc-4d07-a2b5-32f6a8073f03`）。

#### 3) 配置 DNS 路由

```bash
cloudflared tunnel route dns raven raven.example.com
cloudflared tunnel route dns raven raven-api.example.com
```

这会在 Cloudflare DNS 自动创建指向 Tunnel 的 CNAME 记录。

#### 4) 创建配置文件

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: <你的Tunnel-ID>
credentials-file: /home/<用户>/.cloudflared/<Tunnel-ID>.json

ingress:
  - hostname: raven-api.example.com
    service: http://127.0.0.1:7024
  - hostname: raven.example.com
    service: http://127.0.0.1:7023
  - service: http_status:404
```

#### 5) 安装为系统服务

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/
sudo cp ~/.cloudflared/<Tunnel-ID>.json /etc/cloudflared/
sudo cloudflared service install
```

验证状态：

```bash
sudo systemctl status cloudflared
```

应该看到多个 `Registered tunnel connection` 日志，表示隧道已建立。

#### 6) 可选：Cloudflare WAF IP 限制

如果需要限制访问 IP，在 Cloudflare Dashboard → Security → WAF → Custom rules 添加规则：

**Expression:**
```
(http.host in {"raven-api.example.com" "raven.example.com"}) and not (ip.src in {你的IP/24})
```

**Action:** Block

这样只有白名单 IP 才能访问，其他请求在 Cloudflare 边缘就被拦截。

---

## 9. 部署后的客户端配置

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://raven-api.example.com
export ANTHROPIC_API_KEY=<your RAVEN_API_KEY>
```

### OpenAI-compatible clients

```text
Base URL: https://raven-api.example.com/v1
API Key:  <your RAVEN_API_KEY>
```

---

## 10. 升级流程

使用 `bun run start` 一键完成构建和启动：

```bash
cd /srv/raven
git pull
bun install
sudo systemctl restart raven-proxy.service raven-dashboard.service
```

> **注意**：systemd 服务使用 `bun run --filter <pkg> start` 启动单个包。如果你想在命令行手动启动全部服务并自动重新构建，可以直接运行 `bun run start`（它会先执行 `bun run build` 再启动）。

---

## 11. 备份与持久化

至少备份以下内容：

- `/srv/raven/data/raven.db`
- `/srv/raven/config/github_token`
- `/etc/raven/proxy.env`
- `/etc/raven/dashboard.env`

其中：

- `raven.db` 保存请求日志、设置、DB-managed keys
- `github_token` 保存 GitHub / Copilot 授权状态

如果换机，只要 repo 代码版本兼容，恢复这些文件后通常即可继续运行。

---

## 12. 验证清单

部署完成后至少验证：

1. `https://raven.example.com` 能正常打开 dashboard
2. dashboard 页面能正常读取 proxy 数据
3. `https://raven-api.example.com/api/connection-info` 返回的地址是公网 HTTPS URL
4. 使用 `RAVEN_API_KEY` 可以成功调用 `/v1/messages` 或 `/v1/chat/completions`
5. `sudo systemctl restart raven-proxy.service` 后服务可恢复
6. VM 重启后两项服务自动拉起

---

## 13. 常见坑

### 1) 混用包管理器

不要运行 `npm install` / `pnpm install`。本项目只使用 bun workspace；混用包管理器会制造重复依赖实例，导致 dashboard 测试或运行时异常。

### 2) 直接暴露 7023 / 7024

这两个端口应只监听本机并通过反向代理（Nginx 或 Cloudflare Tunnel）暴露；不要在云平台安全组中直接开放。

### 3) 公开 dashboard 但仍使用 local mode

如果 dashboard 对公网开放，**必须启用 Google OAuth**，并限制 `ALLOWED_EMAILS`。见上方「远程部署安全须知」。

### 4) `RAVEN_BASE_URL` / `NEXTAUTH_URL` 仍指向 localhost

这会导致 connection info、登录回调或 cookie 行为异常；生产环境必须改成公网 HTTPS 地址。

### 5) Nginx 未设置 `proxy_read_timeout`（504 Gateway Timeout）

Nginx 默认 `proxy_read_timeout` 为 60 秒。LLM 流式请求（尤其是 Opus + 大上下文）在上游返回第一个 token 前可能超过 60 秒，导致 Nginx 提前断开连接返回 504。`raven-api` 的 location 块必须设置 `proxy_read_timeout 300s`（见第 8 节配置示例）。

---

## 14. 安全架构总结

完整部署后的安全层级：

| 层 | 措施 | 效果 |
|---|------|------|
| 网络层 | Cloudflare Tunnel / Nginx | 零端口暴露或最小端口暴露 |
| CDN 层 | Cloudflare WAF IP 白名单 | 只有指定 IP 段能访问 |
| 应用层 | Dashboard Google OAuth | 只有指定邮箱能登录 |
| API 层 | API Key (`rk-xxx`) | 请求需要携带有效 key |
| 应用层 | Raven IP Whitelist (可选) | 双重 IP 校验 |

**关键资产保护**：

- `github_token` — 存储 GitHub / Copilot 授权，是核心敏感文件。确保 VPS 安全（SSH 密钥登录、fail2ban）。
- API Key — 建议定期轮换，可在 Dashboard 创建多个 key 按用途区分。
