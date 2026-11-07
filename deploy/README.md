# 五子棋（Gomoku Online）部署手册

目标地址：<https://wkeeli.cn/gomoku/>（公开访问，无密码）
代码开源：<https://github.com/wzqfwanj/gomoku-online>

本手册只覆盖 **部署**。`web/`（前端）与 `server.py`（后端）由其他成员编写；
`deploy/` 目录内三个文件是本目录产物。

---

## 0. 拓扑与已核实事实

```
浏览器
  │ https://wkeeli.cn/gomoku/
  ▼
[aliyun 8.133.209.25]  Caddy 2.11.4 (systemd: caddy.service, User=caddy)
  │   handle_path /gomoku/*  →  strip 前缀
  ▼ http://180.76.180.249:8086
[dev 180.76.180.249]   Ubuntu 24.04 / Python 3.12.3 / systemd: gomoku.service
  │
  └─ /opt/gomoku/server.py  (WorkingDirectory=/opt/gomoku)
```

勘察结果（2026-11-07 CST 实测，均只读）：

| 项目 | 结果 |
| --- | --- |
| `systemctl status caddy` | `active (running)`，enabled，2 个月无重启 |
| Caddy 版本 | `v2.11.4`，`/usr/bin/caddy` |
| 配置校验 | `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` → `Valid configuration` ✅ |
| 重载方式 | `systemctl reload caddy`，ExecReload=`/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force`；admin API 监听 `127.0.0.1:2019` |
| Caddyfile | `/etc/caddy/Caddyfile`（4702 B，属主 root，**未按 `caddy fmt` 格式化**） |
| 兜底语句 | 第 132 行 `reverse_proxy localhost:5000`（`wkeeli.cn` 块内），新块必须插在它之前 |
| 站级安全头 | 有 CSP（`default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' …`）、HSTS、X-Frame-Options DENY、`-Server` |
| dev 8086 | 空闲（dev 已占用 8000/8001/8002/8003/8010/8030/8040/8060；8787 属 interview-review） |
| dev 防火墙 | `ufw inactive`；监听在 `0.0.0.0:8086` |
| **连通性实测** | dev 起临时 `python3 -m http.server 8086 --bind 0.0.0.0`，从 aliyun `curl http://180.76.180.249:8086/` → **HTTP 200**（connect 0.031 s）。已 kill 临时进程，`ss` 确认 8086 释放、无残留 |
| dev /opt 命名习惯 | 小写、连字符/下划线：`architecture/`、`pdf2pptx/`、`schedul/`、`superrecord/`、`jd-analyzer/`、`supersys/`、`calculator/`；故用 `/opt/gomoku` |
| dev 服务命名习惯 | `/etc/systemd/system/<name>.service`，`Type=simple`、`After=network.target`、`Restart=always` 或 `Restart=on-failure`；architecture 用独立系统用户 + 强加固，supersys 直接以 root 跑 |
| dev 工具 | `rsync 3.2.7`、`tar`、`git`、`curl`、`python3.12` 均在 `/usr/bin` |
| 本机（Windows） | `ssh`/`scp`/`tar`/`git`/`gh`/`python` 可用；**本机没有 rsync**（用 `scp -r` 或 Git Bash 里 tar 管道） |
| GitHub | `gh` 已登录 `wzqfwanj`（scopes: `repo`, `workflow`, `delete_repo`, `gist`, `read:org`, `user`，HTTPS）；`wzqfwanj/gomoku-online` **尚不存在**；全局 `user.name`/`user.email` **未设置** |

---

## 1. 同步代码到 dev

代码位于本机工作目录 `C:\Users\26876\Desktop\五子棋`。
`server.py` 在仓库根，前端在 `web/`，两者都放到 `/opt/gomoku/`，保持 `server.py` 能按相对路径找到 `web/`。

```powershell
# Windows PowerShell（OpenSSH scp 会自动走 ~/.ssh/config 里的 ProxyJump aliyun）
ssh dev "mkdir -p /opt/gomoku"
scp -r .\server.py .\web dev:/opt/gomoku/
```

替代方式（Git Bash，本机无 rsync，用 tar 管道；PowerShell 管道传二进制不可靠，务必用 bash）：

```bash
cd "/c/Users/26876/Desktop/五子棋"
tar czf - server.py web | ssh dev "tar xzf - -C /opt/gomoku"
```

同步后校验：

```bash
ssh dev "ls -la /opt/gomoku && python3 -c 'import ast,sys; ast.parse(open(\"/opt/gomoku/server.py\").read()); print(\"syntax OK\")'"
```

注意事项：

- **行尾**：Linux 上 `server.py` 必须是 LF。若本机 `core.autocrlf=true`，请在仓库加 `.gitattributes`（`*.py text eol=lf`）或同步前转换，否则 shebang/字符串里可能出现 `\r`。
- `/opt/gomoku` 不要 `chmod 777`；服务若以 root 跑（见下）无需额外属主调整。
- 不要动 `/opt/` 下其他服务目录。

---

## 2. 安装 systemd 服务（dev）

`deploy/gomoku.service` 内容要点：`Description=Gomoku online`、`WorkingDirectory=/opt/gomoku`、
`ExecStart=/usr/bin/python3 /opt/gomoku/server.py --host 0.0.0.0 --port 8086`、
`Restart=always`、`RestartSec=2`、stdout/stderr 进 journald。

```powershell
# 本机 → dev
scp .\deploy\gomoku.service dev:/etc/systemd/system/gomoku.service
```

```bash
# dev 上
systemctl daemon-reload
systemctl enable --now gomoku
systemctl status gomoku --no-pager -l
journalctl -u gomoku -n 50 --no-pager
# 本机自测（绕过 Caddy，先确认应用本身 OK；健康检查返回 {"ok":true,"rooms":N}）
curl -sS -m 5 -o /dev/null -w 'direct 8086 = %{http_code}\n' http://127.0.0.1:8086/
curl -sS -m 5 http://127.0.0.1:8086/api/health; echo
```

> 若后续需要非 root 运行：`useradd --system --home /opt/gomoku --shell /usr/sbin/nologin gomoku`
> 并在 unit 里加 `User=gomoku`/`Group=gomoku`，同时 `chown -R gomoku:gomoku /opt/gomoku`。
> 默认 unit 不写 `User=`，与 dev 上 `supersys.service` 一致，以 root 运行，避免写状态文件时踩权限。

---

## 3. 配置 Caddy 子路径反代（aliyun）

**原则：先备份 → 插入 → 校验 → reload；校验失败绝不 reload。**

### 3.1 备份并用现有片段覆盖前先确认锚点

```bash
# aliyun 上（root）
cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-gomoku-$(date +%Y%m%d-%H%M%S)
# 确认兜底语句唯一且在 wkeeli.cn 块内、以及没有历史 /gomoku 残留
grep -n "reverse_proxy localhost:5000" /etc/caddy/Caddyfile   # 期望恰好 1 行（约 132）
grep -n "/gomoku" /etc/caddy/Caddyfile && echo "已存在，勿重复插入" || echo "无 gomoku 路由，可插入"
```

### 3.2 上传片段到 aliyun

```powershell
# 本机
scp .\deploy\caddy-snippet.conf aliyun:/tmp/gomoku-snippet.conf
```

### 3.3 插入片段（在 `reverse_proxy localhost:5000` 之前）

```bash
# aliyun 上（root）。幂等：已存在 /gomoku 时直接报错退出
python3 - <<'PY'
from pathlib import Path
cf   = Path('/etc/caddy/Caddyfile')
snip_path = Path('/tmp/gomoku-snippet.conf')

s = cf.read_text()
snip = snip_path.read_text().rstrip() + '\n\n'
anchor = '\treverse_proxy localhost:5000\n'

assert s.count(anchor) == 1, '锚点 reverse_proxy localhost:5000 不唯一，手工处理'
assert '/gomoku' not in s, '/gomoku 路由已存在，跳过插入'
cf.write_text(s.replace(anchor, snip + anchor, 1))
print('inserted before line:', s[:s.index(anchor)].count('\n') + 1)
PY

# 人工复核：新块应紧挨在兜底语句之前
grep -n -A3 -B1 "redir /gomoku" /etc/caddy/Caddyfile
```

### 3.4 校验 + 重载

```bash
# aliyun 上（root）——这两条是唯一合法的校验/重载方式
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile     # 必须输出 Valid configuration
systemctl reload caddy                                               # 等价 caddy reload --config /etc/caddy/Caddyfile --force
systemctl is-active caddy                                            # active
journalctl -u caddy -n 30 --no-pager                                 # 无 error 即可
```

- `caddy validate` 只做加载/下发校验，不会改运行态；**失败就不要 reload**，直接回滚（见 §5）。
- **不要运行 `caddy fmt --overwrite`**：现网 Caddyfile 本来就未按 fmt 排版，整文件重排会污染未来所有 diff。
- Caddy 以 `User=caddy` 运行，但配置由 root 管理、reload 走 root→admin API（127.0.0.1:2019），无需改权限。
- 若 `systemctl reload caddy` 报 admin API 连接失败，可退化为 `caddy reload --config /etc/caddy/Caddyfile --force`（root 执行）。

---

## 4. 验收（必须全过）

### 4.0 后端 API 契约（2026-11-07 后端已交付，本地 38 项断言通过；本节命令已按此核对）

| 方法 & 路径 | 参数 / 请求体 | 成功响应 | 备注 |
| --- | --- | --- | --- |
| `GET /api/health` | — | `{"ok":true,"rooms":N}` | 最轻量探活，验收优先用 |
| `POST /api/room` | 无 body | `{"roomId":"ZNSHCQ","token":"<hex32>","color":1}` | roomId 6 位大写字母数字，token 32 位 hex |
| `POST /api/join` | `{"roomId","token"}`（token 空 = 观战） | `{"roomId","token","color":2/0}` | 空位补 white，满员返回观战 color=0 |
| `POST /api/move` | `{"roomId","token","x","y"}` | `{"ok":true}` | 0..14，错误码 `not_your_turn`/`invalid_move`/`game_over` 等 |
| `POST /api/restart` | `{"roomId","token"}` | `{"ok":true}` | 双方 ready 后重开 |
| `GET /api/stream?room=<ROOM>&token=<TOKEN>` | 查询串 | `text/event-stream`，`event: state` | 无效房间 → 404 `{"error":"room_not_found"}` |
| `GET /`、`/index.html`、`/app.js`、`/style.css`、`/favicon.svg` | — | 静态文件 | 后端从 `web/` 读（`WEB_DIR`） |

- SSE 语义：新连接立即收到一帧当前状态；每帧 `flush()`；空闲 15 s 发 `: ping` 心跳；
  响应头含 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`。
- 后端所有路由按**根路径**写（`/api/...`、静态根），依赖 Caddy `handle_path` 剥掉 `/gomoku` 前缀，**不需要**读 `X-Forwarded-Prefix`。
- 经 Caddy 访问时在路径前加 `/gomoku`：`https://wkeeli.cn/gomoku/api/health`。
- 另：房间 2 h 无活动自动回收（`ROOM_TTL`），进程重启丢局（内存态）。

以下命令默认在 **aliyun** 上执行（有 `curl` + `python3`）：

```bash
# 1) 308 跳转：/gomoku → /gomoku/
curl -sS -o /dev/null -w 'no-slash: %{http_code} -> %{redirect_url}\n' https://wkeeli.cn/gomoku
# 期望 308，Location: https://wkeeli.cn/gomoku/

# 2) 首页 200 + 安全头仍在（站级 CSP/HSTS/X-Frame-Options 会被继承到本路由）
curl -sS -o /dev/null -D - https://wkeeli.cn/gomoku/ | head -20
# 期望 HTTP/2 200，且 caddy 注入的 CSP/x-frame-options/nosniff 头存在

# 3) 静态资源 5 个全过（后端 STATIC_FILES 就是这 5 个）
for f in / /index.html /app.js /style.css /favicon.svg; do
  printf '%-14s %s\n' "$f" "$(curl -sS -o /dev/null -w '%{http_code}' "https://wkeeli.cn/gomoku$f")"
done
# 期望全部 200

# 4) 健康检查：直连 vs 经 Caddy 对照（直连 OK 而经 Caddy 502 ⇒ 反代/端口问题）
ssh dev "curl -sS -m 5 http://127.0.0.1:8086/api/health"
curl -sS -m 5 https://wkeeli.cn/gomoku/api/health
# 期望两侧都是 {"ok":true,"rooms":N}

# 5) SSE：先建房拿 roomId + token（POST /api/room 无 body）
read -r ROOM TOKEN <<< "$(curl -sS -X POST https://wkeeli.cn/gomoku/api/room \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["roomId"], d["token"])')"
echo "ROOM=$ROOM TOKEN=${TOKEN:0:8}..."

#    5a. 直连后端：应立即吐出 text/event-stream + 首帧 event: state（新连接立即收到状态）
ssh dev "curl -N -m 6 -sS -D - 'http://127.0.0.1:8086/api/stream?room=$ROOM&token=$TOKEN' | head -12"
#    5b. 经 Caddy：应与 5a 同样"立刻"出数据；若 5a 正常而 5b 卡住 ⇒ 缓冲问题，检查 flush_interval -1
curl -N -m 6 -sS -D - "https://wkeeli.cn/gomoku/api/stream?room=$ROOM&token=$TOKEN" | head -12
#       期望响应头 content-type: text/event-stream、cache-control: no-cache, no-transform
#       curl 的 -N（--no-buffer）必加，否则本地先攒着看不到实时性
#    5c. 心跳：保持连接 >15 s，应看到 `: ping`（共 5 行：state 3 行 + ping 2 行），证明无中间层掐流
curl -N -m 20 -sS "https://wkeeli.cn/gomoku/api/stream?room=$ROOM&token=$TOKEN" | head -5
#    5d. 负例：无效房间应 404 {"error":"room_not_found"}
curl -sS -o /dev/null -w 'bad room = %{http_code}\n' "https://wkeeli.cn/gomoku/api/stream?room=ZZZZZZ&token=x"

# 6) 浏览器实测：开 https://wkeeli.cn/gomoku/ ，DevTools → Network 看 SSE 请求
#    是否 "pending" 状态且 EventStream 面板逐条出现事件；再开两个窗口下一盘棋（黑先手，落子即广播）。

# 7) 日志
ssh dev "journalctl -u gomoku -n 30 --no-pager"     # 应有「五子棋服务已启动: http://0.0.0.0:8086/」与建房日志
ssh aliyun "journalctl -u caddy -n 20 --no-pager"   # 无 error 即可
```

---

## 5. 回滚

按影响面从小到大：

```bash
# A. 只回滚 Caddy 路由（最快，dev 服务继续跑）
# aliyun 上（root）——用 §3.1 生成的备份，文件名按实际时间戳替换
cp -a /etc/caddy/Caddyfile.bak-gomoku-YYYYMMDD-HHMMSS /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
systemctl is-active caddy

# 若连备份都不可用：手工删掉 /gomoku 的 redir + handle_path 两段（保留 reverse_proxy localhost:5000），
# 再 validate → reload。

# B. 停掉并禁用后端服务
systemctl disable --now gomoku
systemctl status gomoku --no-pager -l   # 期望 inactive (dead)

# C. 彻底清理（可选，先确认没人再用）
rm -f /etc/systemd/system/gomoku.service
systemctl daemon-reload
rm -rf /opt/gomoku
# 备份文件 /etc/caddy/Caddyfile.bak-gomoku-* 建议保留，不要删
```

回滚后复验：`curl -sS -o /dev/null -w '%{http_code}\n' https://wkeeli.cn/gomoku/` 应不再是本站内容
（回落兜底 Flask 或 404，符合预期），且 `https://wkeeli.cn/` 其他服务不受影响。

---

## 6. 风险与注意事项

1. **CSP 是全站共享的**：`default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'`。
   前端**不能**引任何外域资源（CDN 的 JS/CSS、Google Fonts、外链图片、`ws://` 明文）。
   - 同源 SSE（`https://wkeeli.cn/gomoku/...`）与同源 WebSocket（`wss://wkeeli.cn/gomoku/...`）在 `connect-src 'self'` 覆盖范围内，**不用改 CSP**。
   - 前端里一切请求都用**相对路径**（`events`、`api/...`），不要写 `http://180.76.180.249:8086`，否则浏览器跨域 + CSP 双杀。
   - 若前端确实需要第三方库，请**下载后放进 `web/` 自行托管**，不要放宽站级 CSP（会影响其他 10+ 个服务）。
2. **SSE 是两层缓冲，都要对**：反代侧 `flush_interval -1` 已配且实测有效；后端已按约定实现
   （`text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`、
   每帧 `flush()`、15 s `: ping` 心跳）。任一层攒批都会表现为"网页能开但棋谱不动"，
   用 §4 的 5a（直连）/5b（经反代）对照法定位是哪一层。
   别用 `python3 -m http.server` 验 SSE（单线程、不 flush）；浏览器 `EventSource` 会自动重连，`: ping` 负责保活。
3. **`handle_path` 会剥掉 `/gomoku` 前缀**：`/gomoku/api/health` → 后端收到 `/api/health`。后端路由已全部按根路径写，
   当前**不依赖** `X-Forwarded-Prefix`（片段仍注入该头，便于将来生成绝对 URL，保留无害）。
4. **尾斜杠**：`/gomoku` 由 `redir ... 308` 补斜杠；前端所有 `fetch` 用相对路径即可，注意相对 `./` 的基准是 `/gomoku/`。
5. **端口与安全组**：8086 已实测 aliyun→dev 可通、ufw inactive；这依赖百度云安全组对 8.133.209.25/公网放行。
   若日后安全组收紧或换端口，先按 §0 的方式重做连通性验证，再改 Caddy 上游，**不要靠猜**。
   dev 上 8000–8060 已被 9 个服务占用，**不要复用 8000/8001/8002/8003/8010/8030/8040/8060**。
6. **公网无认证**：任何人拿到 URL 都能进房。若被刷，优先在应用层加房间数/连接数上限与速率限制；
   不要在全站 Caddyfile 里给 `/gomoku` 加 `basic_auth`（用户已确认公开访问，且会影响其他路由的定位）。
7. **状态在内存**：`Restart=always` 只保证进程活着，重启即丢局。需要持久化就写文件到 `/opt/gomoku/data/`（注意 working dir 与权限）。
8. **`caddy fmt` 陷阱**：现网 Caddyfile 未 fmt，别整体格式化；只做最小插入，diff 越小越安全。
9. **journald 会滚**：长期跑记得 `journalctl --disk-usage` / `/etc/systemd/journald.conf` 限额，别让日志撑满根盘。
10. **改动范围纪律**：本手册只动 `/etc/caddy/Caddyfile`（备份+插入）、`/etc/systemd/system/gomoku.service`、`/opt/gomoku`；
    不碰 `/opt/` 下其他服务、不改站级 header/CSP、不改 `dsh.wkeeli.cn` 等其它 site block。

---

## 7. GitHub 发布（本机）

已核实状态（2026-11-07）：

- `gh auth status` → 已登录 `github.com` 账号 **wzqfwanj**（keyring，HTTPS，scopes：`repo`、`workflow`、`delete_repo`、`gist`、`read:org`、`user`）。
- `gh api user` → login `wzqfwanj`，name `wkeeli_1`，email `null`。
- `gh repo view wzqfwanj/gomoku-online` → **不存在**（未创建）。
- `git config --global --list` → 仅有 `safe.directory=*`；**`user.name` / `user.email` 均为空**（不设会提交失败或产生乱码作者）。

建议设置（与本机 gh 账号对齐；`117358539` 是 `gh api user` 返回的 id）：

```powershell
git config --global user.name  "wzqfwanj"
git config --global user.email "117358539+wzqfwanj@users.noreply.github.com"
# 若更想用 GitHub 显示名：user.name 改为 "wkeeli_1"（提交归属仍靠 email 匹配，noreply 最稳）
```

初始化并发布（在仓库根 `C:\Users\26876\Desktop\五子棋` 执行；`gh repo create --source .` 会自动加 remote 并 push）：

```powershell
git init -b main
# .gitignore 至少包含：__pycache__/、*.pyc、.venv/、*.log、.DS_Store
git add -A
git commit -m "feat: gomoku online (web + python stdlib server) + deploy configs"
gh repo create wzqfwanj/gomoku-online --public --description "五子棋联网对战 Gomoku Online" --source . --remote origin --push
# 已手工建仓库时改用：git remote add origin https://github.com/wzqfwanj/gomoku-online.git && git push -u origin main
```

发布后核验：

```powershell
gh repo view wzqfwanj/gomoku-online --json name,visibility,url,defaultBranchRef
# 期望 visibility=PUBLIC（用户已确认开源）
```

> 公开仓库注意：不要提交任何密钥、`.env`、私钥、服务器密码；`deploy/README.md` 里也不放真实口令。

---

## 8. 已确认项 / 遗留项

已确认（2026-11-07 后端交付后逐条核对，本节命令均已据此改写）：

- [x] `server.py` 支持 `--host/--port`，默认 `0.0.0.0:8086`，**与 unit 的 `ExecStart` 一致**（`/usr/bin/python3` 为 dev 的 Python 3.12.3 绝对路径）。
      已用与 unit 同款参数在本机冒烟：`python server.py --host 127.0.0.1 --port 18086` → `/api/health` 200、静态 200、`POST /api/room` 返回 roomId/token、SSE 首帧立即到达、无效房间 404。
- [x] SSE 路径 `GET /api/stream?room=<ROOM>&token=<TOKEN>`；首帧 `event: state`；15 s `: ping`；每帧 flush；`X-Accel-Buffering: no`。
- [x] 其余 API：`GET /api/health`、`POST /api/room`、`/api/join`、`/api/move`、`/api/restart`（契约见 §4.0）。
- [x] 静态文件：`/`、`/index.html`、`/app.js`、`/style.css`、`/favicon.svg`（后端从 `web/` 读）。
- [x] 后端路由全部按根路径写，依赖 `handle_path` 剥前缀，**不需要**读 `X-Forwarded-Prefix`。
- [x] `.gitattributes` 已含 LF 规则（`* text=auto` + `*.py/*.html/*.css/*.js/*.md/*.conf/*.service/*.svg` 均为 `eol=lf`）。

遗留（可选，不阻塞上线）：

- [ ] unit 是否保持 root 运行（当前与 dev 上 `supersys.service` 一致；要隔离再加 `User=gomoku` + `chown -R`）。
- [ ] 是否加应用层房间/连接上限（公网无密码，被刷时用；不改 Caddy 的 basic_auth）。
- [ ] 房间 2 h 无活动由 `cleaner_loop` 自动回收（`ROOM_TTL`），暂无持久化需求。

---

## 9. 实际部署记录（2026-11-07 23:32–23:35 CST，ops 执行）

上线地址：<https://wkeeli.cn/gomoku/>（`/gomoku` → 308 → `/gomoku/` → 200，公开无密码）
部署基线：本机 `main` @ `1ed416f`（<https://github.com/wzqfwanj/gomoku-online>）

### 9.1 部署清单

| 项目 | 值 |
| --- | --- |
| dev 代码目录 | `/opt/gomoku/`（只传 `server.py` + `web/`，未传 `.git` / `tests/`） |
| server.py sha256 | `75bc5c79…f7198`（与本地一致） |
| web/* sha256 | `8d489b4e…af92`（app.js）/ `276d5a4b…60c7`（favicon.svg）/ `b81735c5…3fe1`（index.html）/ `616b4fe0…0569`（style.css），均与本地一致 |
| systemd unit | `/etc/systemd/system/gomoku.service` sha256 `ab210c3a…76fa`；`enabled` + `active`；`MainPID=3011507`；`NRestarts=0` |
| 监听 | `0.0.0.0:8086`（`ss -tlnp`） |
| Caddyfile 备份 | `/etc/caddy/Caddyfile.bak-gomoku-20261107-233249`（sha256 `345afbcf…260e`，与改动前现网一致） |
| Caddy diff | **+20 / -0 行**（`diff -u` 共 29 行）；插入位置：原第 132 行兜底 `reverse_proxy localhost:5000` 之前 |
| caddy 校验/重载 | `caddy validate …` → `Valid configuration`；`systemctl reload caddy` → OK；caddy `active`、`NRestarts=0` |
| 同步方式 | 本机 `scp -r .\server.py .\web dev:/opt/gomoku/`（本机无 rsync） |

### 9.2 验收结果（全部实测通过）

- 跳转/首页：`/gomoku` → **308** → `/gomoku/` → **200** `text/html`，`<title>五子棋</title>`
- 静态：`/gomoku/app.js`、`/gomoku/style.css`、`/gomoku/favicon.svg` → **200**；`/gomoku/api/health` → **200** `{"ok":true,…}`
- SSE（经 Caddy，Python urllib 客户端）：首帧 `event: state` **t=0.140 s**；心跳 `: ping` **t=15.062 s**；
  响应头 `text/event-stream; charset=utf-8`、`X-Accel-Buffering: no`、`Cache-Control: no-cache, no-transform`、`Via: 1.1 Caddy`
- 对局链路：建房 `RKYRKN` / `5A6VAR` → 加入 color=2 → 黑落 (7,7) → state `turn=2, moves=1, lastMove={7,7,1}` →
  非己方回合 400 `not_your_turn` → 白落 (8,8) → state `moves=2, turn=1`、`board[7][7]=1`、`board[8][8]=2` →
  无效房间 SSE 404 `room_not_found`
- 回归（改动前后一致）：`/` 200、`/arch/` 401、`/schedul/` 302、`/pdf2ppt/` 200、`/lst/` 200
- 站级安全头仍在：CSP / HSTS / `X-Frame-Options: DENY` / `nosniff`
- 前端自查：`web/` 三个文件无任何外域 URL（符合 `default-src 'self'`）
- 测试房间不清理，靠 `ROOM_TTL` 2 h 自动过期
- 说明：Caddy 日志中 SSE 的 `aborting with incomplete response` / `reading: context canceled` 属测试客户端主动断开的正常 warn，非故障

### 9.3 本次回滚命令（完整可直接粘贴）

```bash
# aliyun（root）：恢复 Caddy 配置并重载（dev 后端可继续跑）
cp -a /etc/caddy/Caddyfile.bak-gomoku-20261107-233249 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
systemctl is-active caddy

# dev（root）：停用后端
systemctl disable --now gomoku
systemctl status gomoku --no-pager -l

# 可选：彻底清理
rm -f /etc/systemd/system/gomoku.service && systemctl daemon-reload && rm -rf /opt/gomoku
```

### 9.4 2026-11-07 补丁重部署（server.py @4fdc7e6，Caddy 未改动）

线上原运行部署版 server.py `@1ed416f`（sha256 `75bc5c79…f7198`）。补丁 commit `4fdc7e6` **仅改 server.py**（接口不变），
故只替换 `/opt/gomoku/server.py` + `systemctl restart gomoku`，**Caddy 未做任何改动、未 reload**。

**本次修复内容**

1. `POST /api/restart` 仅终局后可重开：对局中（`winner == 0`）→ `400 {"error":"game_not_over"}`（旧版 200 会清盘）。
2. 拒绝带 `Transfer-Encoding: chunked` 的 POST → `400 {"error":"bad_request"}`（避免 chunk 残留字节污染 keep-alive 下一条请求）。
3. SSE 断线主动探测：等待循环用 `select + recv(MSG_PEEK)` 每秒探测对端关闭，客户端刷新/关页约 1 s 发现、3 s 去抖后广播（旧版最坏 ~18 s）；心跳仍 15 s。

**部署记录**

| 项目 | 值 |
| --- | --- |
| 部署时间 | 2026-11-07 23:43 CST |
| 新 server.py sha256 | `8b755942…516a30`（20563 B，与本地 `4fdc7e6` 一致） |
| 旧版备份（回滚用） | `/opt/gomoku/server.py.bak-1ed416f-20261107-234250`（sha256 `75bc5c79…f7198`） |
| 校验 | `python3 -m py_compile` → OK；无 `__pycache__` 残留 |
| 服务 | `systemctl restart gomoku` → active；MainPID `3011507 → 3017294`；`ActiveEnterTimestamp` 23:43:16；`NRestarts=0`（手动重启不计） |
| 监听/健康 | `0.0.0.0:8086`；`curl 127.0.0.1:8086/api/health` → `{"ok":true,…}` 200 |
| Caddy | **未改动**：Caddyfile md5 `2a2d5e3af9af4079c045ab91770a5a7b`、`redir /gomoku` 计数 1、caddy active、`NRestarts=0` |

**验收（2026-11-07 23:43–23:44 CST，经 Caddy 实测，15 项断言 ALL_PASS）**

- 关键修复①：建房→加入→黑落 (7,7) → 黑方 `POST /api/restart` → **400 `{"error":"game_not_over"}`**；随后 state 仍 `moves=1 / board[7][7]=1 / winner=0`（未清盘）
- 关键修复②：带 `Transfer-Encoding: chunked` 的 `POST /gomoku/api/room` → **400 `{"error":"bad_request"}`**（经 Caddy TLS 与直连 dev:8086 均如此）
- 关键修复③：白方保持 SSE，黑方裸 TLS 订阅后立即 RST 断开 → 白方 **3.972 s** 收到 `players.black.connected=false`（= 1 s 探测 + 3 s 去抖，旧版最坏 ~18 s）
- 回归：5 个静态资源 + `/api/health` 全 200；`<title>五子棋</title>`；SSE 首帧 **0.033 s**、心跳 **15.002 s**；无效房间 SSE 404 `room_not_found`
- 接口不变验证：终局（黑连五，9 手）后 black/white 各 `POST /api/restart` 均 **200**，重开后 state `winner=0 / moves=0 / turn=1`
- 主站回归：`/` 200、`/arch/` 401、`/schedul/` 302、`/pdf2ppt/` 200（与基线一致）；Caddy 日志无 gomoku 相关 error

**回滚（仅 server.py，Caddy 不动）**

```bash
# 方式 A：用 dev 上的旧版备份（推荐，最快）
ssh dev "cp -a /opt/gomoku/server.py.bak-1ed416f-20261107-234250 /opt/gomoku/server.py && systemctl restart gomoku && systemctl is-active gomoku && curl -sS http://127.0.0.1:8086/api/health"

# 方式 B：从 git 取上一版再 scp（本机）
git show 1ed416f:server.py > server.py.1ed416f
scp .\server.py.1ed416f dev:/opt/gomoku/server.py
ssh dev "systemctl restart gomoku"
# 之后 git checkout -- server.py 恢复本地文件即可
```

> 补丁只影响 server.py，**无需回滚 Caddy**。回滚到 1ed416f 即恢复旧行为（对局中 restart 会清盘、chunked 不拒绝、SSE 断线最坏 ~18 s 才发现）——这正是本次修复点，非必要不回滚。

---

### 9.5 2026-11-08 音乐/视觉分支部署（server.py + web/ + Caddy CSP media-src）

合并 commit `ebdda93`（feat/music-visuals → main）。本次线上变更三处：前端 `web/`（彩色氛围背景 + 音乐播放器，
新增 `playlist.json` / `MUSIC-CREDITS.md`）、`server.py`（新增静态路由 `/playlist.json`）、Caddy 站级 CSP 的
`media-src` 追加 `https://incompetech.com`（否则外链音频被站点 CSP 拦截）。

**部署清单**

| 项目 | 值 |
| --- | --- |
| 部署时间 | 2026-11-08 00:24 CST |
| 代码基线 | `ebdda93`（merge feat/music-visuals） |
| server.py sha256 | `72de5020…586d`（20639 B） |
| web/ sha256 | app.js `0da61036…1ed5`、favicon.svg `6a99a1b4…4bd7`、index.html `7c4be1ed…c150`、MUSIC-CREDITS.md `e4440502…2c7f`、playlist.json `859f9645…ab7e`、style.css `98ecc0b2…6421`（全部与本地一致） |
| 旧版备份（回滚用） | `/opt/gomoku/backup-526894c-20261108-002346.tar.gz`（旧 server.py + web/，sha256 `950ce7bb…06a1`） |
| 服务 | `systemctl restart gomoku` → active；MainPID `3017294 → 3038589`；`ActiveEnterTimestamp` 00:24:17；`NRestarts=0` |
| 监听/健康 | `0.0.0.0:8086`；`/api/health` → `{"ok":true,…}` 200 |
| Caddy 备份 | `/etc/caddy/Caddyfile.bak-gomoku-20261108-002347` |
| Caddy diff | **+1 / -1 行**（仅 CSP `media-src` 一行） |
| Caddy 操作 | `caddy validate` → `Valid configuration`；`systemctl reload caddy` → OK；caddy active、`NRestarts=0`（未重启） |

**Caddy CSP 变更（唯一一处）**

```diff
- media-src 'self' blob: https://*.aliyuncs.com
+ media-src 'self' blob: https://*.aliyuncs.com https://incompetech.com
```

（`default-src` / `script-src` / `style-src` / `connect-src` / `img-src` 与 HSTS、X-Frame-Options、nosniff 全部未动）

**验收（2026-11-08 00:24–00:26 CST，ALL_PASS）**

- `/gomoku/` 200 HTML、`<title>五子棋</title>`；页面 meta CSP 含 `media-src … https://incompetech.com`；`<audio id="music-audio">` 与 `#music-play` 存在
- `/gomoku/playlist.json` 200 `application/json; charset=utf-8`（3155 B），JSON 合法、7 首曲目且 URL 全为 incompetech
- 响应头 CSP 的 `media-src` 已含 `https://incompetech.com`；其余 CSP 指令逐字未变（`/arch/` 等其他路径同头）
- 外链音乐：`Referer: https://wkeeli.cn/gomoku/` + `Range: 0-1023` → **206** `application/octet-stream`（1024 B，1.79 s）
- **Playwright + Edge 线上 E2E：`python tests/test_e2e.py --base https://wkeeli.cn/gomoku/` → 36/36 PASS**，含
  「点击后开始播放（`audio.paused=false` 且 `currentTime>0`）」「播放时请求外链音乐」「下一首/音量/记忆/暂停/CC BY 署名」
  「观战/黑白对弈/五连判胜/双方再来一局/刷新保座/明暗主题/移动端」「无 JS/控制台错误」；截图输出到本机 `%TEMP%\gomoku-e2e\`
- 线上 API 回归（经 Caddy，17 项 ALL_PASS）：建房/加入/落子、SSE 首帧 **0.029 s** + 心跳 **15.002 s**、无效房 404、
  对局中 restart 400 `game_not_over`、chunked POST 400 `bad_request`、终局后双方 restart 200
- 主站回归（本机外网 + aliyun 双视角，**不跟随重定向**）：`/` 200、`/arch/` 401、`/schedul/` 302、`/pdf2ppt/` 200、`/lst/` 200，与基线一致
- 静态 5 件 + `/api/health` 全 200；Caddy 日志无 gomoku 相关 error

**回滚（两处，建议一起回）**

```bash
# 1) aliyun：恢复 CSP（只影响 media-src 一行）
cp -a /etc/caddy/Caddyfile.bak-gomoku-20261108-002347 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
systemctl is-active caddy

# 2) dev：恢复旧版 server.py + web/ 并重启
ssh dev "cd /opt/gomoku && tar xzf backup-526894c-20261108-002346.tar.gz && systemctl restart gomoku && systemctl is-active gomoku && curl -sS http://127.0.0.1:8086/api/health"

# 3) 可选：从 git 重新同步旧版（本机）
git checkout 526894c -- server.py web
scp .\server.py dev:/opt/gomoku/server.py
scp -r .\web dev:/opt/gomoku/
ssh dev "systemctl restart gomoku"
# 之后 git checkout ebdda93 -- server.py web 恢复本地新版
```

> 只回滚代码、不回滚 CSP 也安全（多放行一个媒体域无副作用）；但只回滚 CSP 而不回滚代码会让音乐按钮被 CSP 拦截而静默失败——**回滚时两处一起回**。

---

### 9.6 2026-11-08 平台版部署（多游戏：五子棋悔棋/比分 + 连连看）

合并 commit `3d732a7`（merge feat/platform-lianliankan）。本次为**纯代码部署，Caddy 零改动**（路径与 CSP 均不变）：
`server.py` 重构为多游戏平台（Room 基类 + GomokuRoom / LianliankanRoom，新增 `/api/undo`、`/api/match`、
`/api/hint`、`/api/shuffle`，state 新增 `game` / `score` / `undoLeft` / `boards` / `cleared`），
`web/` 换平台首页（五子棋/连连看卡片、悔棋 + 跨局比分、双人竞速连连看），新增 `llk.js` / `llk.css`。

**部署清单**

| 项目 | 值 |
| --- | --- |
| 部署时间 | 2026-11-08 01:04 CST |
| 代码基线 | `3d732a7` |
| server.py sha256 | `2ee1482c…b935`（35029 B） |
| web/ sha256 | app.js `9c5d6200…9e2f`、favicon.svg `6a99a1b4…4bd7`、index.html `0f88e5fd…25cb`、llk.css `57a6a8a5…053a`、llk.js `56dbb8e6…4fa4`、MUSIC-CREDITS.md `e4440502…2c7f`、playlist.json `859f9645…ab7e`、style.css `3103db8d…e074`（全部与本地一致） |
| 旧版备份（回滚用） | `/opt/gomoku/backup-3d732a7-20261108-010401.tar.gz`（部署前版本 @ebdda93 的 server.py + web/，sha256 `202acf6f…2074`） |
| 服务 | `systemctl restart gomoku` → active；MainPID `3038589 → 3058892`；`ActiveEnterTimestamp` 01:04:14；`NRestarts=0` |
| 监听/健康 | `0.0.0.0:8086`；`/api/health` → `{"ok":true,…}` 200 |
| **Caddy** | **未改动**：active、`NRestarts=0`；Caddyfile md5 `1108a6cf428ce959c4014c05ef46928b`，与 §9.5 备份 `Caddyfile.bak-gomoku-20261108-002347` 相比仍只有 CSP `media-src` 的 +1/-1；`redir /gomoku` 计数 1；CSP 响应头未变 |

**验收（2026-11-08 01:04–01:06 CST，ALL_PASS）**

- 首页 `/gomoku/` 200，`<title>联机小游戏</title>`；页面无旧规则文案「15×15 棋盘，黑方先行」（HTML 命中 0 次）
- `/gomoku/llk.js` 200 `text/javascript; charset=utf-8`（36898 B）、`/gomoku/llk.css` 200 `text/css; charset=utf-8`（14059 B）、`/gomoku/playlist.json` 200 `application/json`（3155 B）；静态 5 件全 200
- API 线上冒烟（经 Caddy）：建房 `{"game":"gomoku"}` → `game=gomoku`；`{"game":"lianliankan"}` → `game=lianliankan`，
  state `boards.black` / `boards.white` 各 **64** 格、`cleared {0,0}`；`/api/hint` 返回 `{x1,y1,x2,y2}` 且 `/api/match` **200**、`cleared.black=1`、两格清空；
  `/api/shuffle` 200；`state.score`=`{black:0,white:0}`、`undoLeft`=`{black:3,white:3}`；
  黑落子后 `/api/undo request` **200** → 白方 `accept` **200** → 棋盘清空（`moves=0`）、黑方悔棋剩 2 次；
  负例：对局中 restart 400 `game_not_over`、move/undo 到连连看房 400 `wrong_game`、非法 game 400 `invalid_game`、无效房 SSE 404、chunked POST 400
- **Playwright + Edge 线上 E2E：`python tests/test_e2e.py --base https://wkeeli.cn/gomoku/` → 42 项通过**
  （平台首页 / 两游戏卡片 / 旧文案已删 / 音乐控件 / 五子棋比分 / 悔棋请求→同意→次数-1 / 五连跨局比分 / 再来一局保留比分 / 刷新保座 / 主题 /
  连连看 64 格 + 提示配对 + 对手进度同步 / 移动端 / 无控制台错误）。
  其中 1 项为 **WARN**：外链音乐 18 s 内未缓冲完成（第三方网络，脚本按设计允许），但「播放时请求外链音乐」「播放态」均 PASS
- SSE 首帧 **0.032 s**、心跳 **15.654 s**；主站回归（不跟随重定向）：`/` 200、`/arch/` 401、`/schedul/` 302、`/pdf2ppt/` 200、`/lst/` 200，与基线一致
- Caddy 日志无 gomoku 相关 error

**回滚（纯代码，Caddy 不动）**

```bash
# dev：用部署前整包备份覆盖并重启
ssh dev "cd /opt/gomoku && tar xzf backup-3d732a7-20261108-010401.tar.gz && systemctl restart gomoku && systemctl is-active gomoku && curl -sS http://127.0.0.1:8086/api/health"

# 可选：从 git 取上一版（本机）
git checkout ebdda93 -- server.py web
scp .\server.py dev:/opt/gomoku/server.py
scp -r .\web dev:/opt/gomoku/
ssh dev "systemctl restart gomoku"
# 之后 git checkout 3d732a7 -- server.py web 恢复本地新版
```

---

### 9.7 2026-11-08 大富翁部署（MonopolyRoom + monopoly 前端）

合并 commit `e02ca09`（merge feat/monopoly）。**纯代码部署，Caddy 零改动**：
`server.py` 新增 `MonopolyRoom`（第三款游戏）与 `/api/roll`、`/api/buy`、`/api/jail`、`/api/build`、`/api/mortgage`、`/api/endturn`，
state 新增 `board` / `owners` / `cash` / `pos` / `phase` / `dice` / `pending` / `log` 等；
`web/` 新增大富翁模块（24 格棋盘、买地/盖房/抵押/监狱/观战/终局）并改为三卡首页。

**部署清单**

| 项目 | 值 |
| --- | --- |
| 部署时间 | 2026-11-08 07:31 CST |
| 代码基线 | `e02ca09` |
| server.py sha256 | `987eedf6…b338`（61873 B） |
| web/ sha256 | app.js `4b0219fd…2450`、favicon.svg `6a99a1b4…4bd7`、index.html `1f88ac07…b55c`、llk.css `57a6a8a5…053a`、llk.js `56dbb8e6…4fa4`、monopoly.css `54d20930…cbc6`、monopoly.js `78379ec5…a3a9`、MUSIC-CREDITS.md `e4440502…2c7f`、playlist.json `859f9645…ab7e`、style.css `96a727da…ac2e`（全部与本地一致） |
| 旧版备份（回滚用） | `/opt/gomoku/backup-e02ca09-20261108-073055.tar.gz`（部署前 @055a014 平台版 server.py + web/，sha256 `6189fa0a…ea08`） |
| 服务 | `systemctl restart gomoku` → active；MainPID `3058892 → 3250845`；`ActiveEnterTimestamp` 07:31:11；`NRestarts=0` |
| 监听/健康 | `0.0.0.0:8086`；`/api/health` → `{"ok":true,…}` 200 |
| **Caddy** | **未改动**：active、enabled、`NRestarts=0`；Caddyfile md5 `1108a6cf428ce959c4014c05ef46928b`（与 §9.5 备份相比仍只有 CSP `media-src` 的 +1/-1）；`redir /gomoku` 计数 1；CSP 响应头未变 |

**验收（2026-11-08 07:31–07:33 CST，ALL_PASS）**

- `/gomoku/` 200，`<title>联机小游戏</title>`，页面含三张游戏卡（五子棋 / 连连看 / 大富翁）
- `/gomoku/monopoly.js` 200 `text/javascript; charset=utf-8`（64483 B）、`/gomoku/monopoly.css` 200 `text/css; charset=utf-8`（23878 B）
- 静态 5 件 + `/llk.js` / `/llk.css` + `/playlist.json` 全 200
- API 线上冒烟（经 Caddy）：
  - 建房 `{"game":"monopoly"}` → `game=monopoly`；第二人加入 color=2、第三人观战 color=0
  - 初始 state：`board` / `owners` 各 **24** 格、`cash {black:1500,white:1500}`、`pos {0,0}`、`phase=roll`、`log` 非空
  - 白方先掷 400 `not_your_turn`；观战者掷骰 400 `not_player`；黑方掷骰 200 → `dice=[1,5]`、`pos.black=6`（点数和 % 24）
  - 掷到 `phase=buy`（地块 5「外滩」）→ `/api/buy {"action":"buy"}` **200** → `owners[5]=1`、现金 1500→1420
  - `build tile=999` 400 `invalid_move`；`mortgage tile=1 action=x` 400 `invalid_move`；`jail pay`（不在监狱）400 `invalid_phase`
  - `endturn` 200 → `turn=2`、`dice=None`；白方掷骰 200
  - 跨游戏：`move` / `undo` 到大富翁房 400 `wrong_game`、`roll` 到五子棋房 400 `wrong_game`、对局中 `restart` 400 `game_not_over`、非法 game 400 `invalid_game`
- **Playwright + Edge 线上 E2E：`python tests/test_e2e.py --base https://wkeeli.cn/gomoku/` → 52 项全 PASS**
  （三卡首页、大富翁建房/加入/24 格棋盘/掷骰/日志/买地、移动端三卡、无控制台错误；本次音乐「外链音频实际播放（currentTime > 0）」也 PASS，无 WARN）
- SSE 首帧 **0.000 s**、心跳 **15.002 s**；无效房 SSE 404、chunked POST 400 均正常
- 主站回归（不跟随重定向）：`/` 200、`/arch/` 401、`/schedul/` 302、`/pdf2ppt/` 200、`/lst/` 200，与基线一致
- Caddy 日志无 gomoku 相关 error

**回滚（纯代码，Caddy 不动）**

```bash
# dev：用部署前整包备份覆盖并重启
ssh dev "cd /opt/gomoku && tar xzf backup-e02ca09-20261108-073055.tar.gz && systemctl restart gomoku && systemctl is-active gomoku && curl -sS http://127.0.0.1:8086/api/health"

# 可选：从 git 取上一版（本机，上一版 = 平台版 @055a014）
git checkout 055a014 -- server.py web
scp .\server.py dev:/opt/gomoku/server.py
scp -r .\web dev:/opt/gomoku/
ssh dev "systemctl restart gomoku"
# 之后 git checkout e02ca09 -- server.py web 恢复本地新版
```
