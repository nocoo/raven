# 14 — Azure VM Deployment

在 Azure VM 上以**单机自托管**方式部署 raven。目标是稳定运行 proxy (`:7024`) + dashboard (`:7023`)，使用反向代理暴露 HTTPS 域名，并通过 systemd 做进程守护。

> **定位提醒**：raven 是研究性、个人使用项目；推荐部署到单台 Ubuntu VM，仅供自己使用，不按多租户服务设计。

---

## 0. 部署拓扑

推荐使用两个域名（也可以用不同 path，但双域名更清晰）：

- `raven-api.example.com` → proxy → `127.0.0.1:7024`
- `raven.example.com` → dashboard → `127.0.0.1:7023`

公网只暴露：

- `22/tcp`（SSH，建议限制来源 IP）
- `80/tcp`（签证书 / HTTP 跳转）
- `443/tcp`（HTTPS）

不要直接向公网开放 `7023` 和 `7024`。

---

## 1. 准备 Azure VM

### 推荐规格

- OS: Ubuntu 24.04 LTS
- Size: B2s 或更高
- Disk: Premium SSD / Standard SSD，确保数据目录持久化

### Azure 网络建议

1. 创建 NSG（Network Security Group）
2. 入站仅允许：
   - `22`（最好限制到你的固定 IP，例如 `203.0.113.10/32`）
   - `80`
   - `443`
3. 不开放：
   - `7023`
   - `7024`

VM 内再配合 UFW：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 2. 安装系统依赖

```bash
sudo apt update
sudo apt install -y curl unzip git nginx
curl -fsSL https://bun.sh/install | bash
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
nginx -v
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
- `data/` 目录不会因重启消失
- 运行用户对 repo 和 `data/` 有写权限

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
RAVEN_TOKEN_PATH=/srv/raven/data/github_token
RAVEN_LOG_LEVEL=info
RAVEN_BASE_URL=https://raven-api.example.com
```

说明：

- 密钥可用 `openssl rand -base64 32` 生成
- `RAVEN_API_KEY`：给 Claude Code / Cursor 等 AI API 客户端使用
- `RAVEN_INTERNAL_KEY`：dashboard 管理接口与日志流使用
- `RAVEN_TOKEN_PATH`：必须放在持久化磁盘上
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

```bash
cd /srv/raven
sudo -u raven bash -c 'export BUN_INSTALL=/home/raven/.bun && export PATH=$BUN_INSTALL/bin:$PATH && export $(cat /etc/raven/dashboard.env | xargs) && bun run --filter dashboard build'
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

## 8. Nginx 反向代理

安装证书最简单的方式通常是 Nginx + Let's Encrypt（例如 certbot）。

先安装 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### API: `/etc/nginx/sites-available/raven-api`

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
    }
}
```

### Dashboard: `/etc/nginx/sites-available/raven-dashboard`

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
        # dashboard 不走 SSE 上游转发，这里通常不需要关闭 buffering
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

每次升级建议按这个顺序：

```bash
cd /srv/raven
git pull
bun install
bun run --filter dashboard build
sudo systemctl restart raven-proxy.service
sudo systemctl restart raven-dashboard.service
```

如果仅 proxy 代码变更，dashboard 不一定要重新 build；但保守做法是每次更新后重新 build 一次 dashboard。

---

## 11. 备份与持久化

至少备份以下内容：

- `/srv/raven/data/raven.db`
- `/srv/raven/data/github_token`
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

这两个端口应只监听本机并通过 Nginx 暴露；不要直接在 Azure NSG 中开放。

### 3) 公开 dashboard 但仍使用 local mode

如果 dashboard 对公网开放，应启用 Google OAuth，并限制 `ALLOWED_EMAILS`。

### 4) `RAVEN_BASE_URL` / `NEXTAUTH_URL` 仍指向 localhost

这会导致 connection info、登录回调或 cookie 行为异常；生产环境必须改成公网 HTTPS 地址。
