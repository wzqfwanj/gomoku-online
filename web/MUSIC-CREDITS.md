# 背景音乐版权与实测记录

> 适用页面：五子棋网页版（分支 `feat/music-visuals`），背景音乐清单文件：`web/playlist.json`。
> 所有曲目均为 **incompetech.com 外链播放**：不下载 mp3 入库、不转存、不改码，浏览器直接请求源站。

## 1. 来源与许可证

- 曲库/作者：**Incompetech — Kevin MacLeod**，<https://incompetech.com>
- 许可证：**Creative Commons Attribution 4.0（CC BY 4.0）**
  - 许可证全文：<https://creativecommons.org/licenses/by/4.0/>
  - 官方许可说明页（可生成署名块）：<https://incompetech.com/music/royalty-free/licenses/>
  - 官方机器可读站点说明（含署名格式）：<https://incompetech.com/llms.txt>

### 本次用来确认曲名/时长的站点页面与接口

| 用途 | URL | 访问结果 |
| --- | --- | --- |
| 站内搜索/流派页（曲目列表 UI） | <https://incompetech.com/music/royalty-free/music.html> | 200，页面由 `pieces.json` 驱动 |
| 全量曲目数据（1443 首，含 title/filename/length/genre/feel） | <https://incompetech.com/music/royalty-free/pieces.json> | 200，881,512 字节 |
| 流派 id → 名称映射 | <https://incompetech.com/music/royalty-free/genre.json> | 200，855 字节 |
| 站点机器可读说明 | <https://incompetech.com/llms.txt> | 200，4,244 字节 |
| 许可证页（官方署名块生成） | <https://incompetech.com/music/royalty-free/licenses/> | 200，12,146 字节 |

直链规则（来自站点说明）：`https://incompetech.com/music/royalty-free/mp3-royaltyfree/` + `pieces.json` 里的 `filename`；空格编码为 `%20`，大小写保持原样。

### 官方署名格式（licenses 页生成）

```text
"Track Title"
Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

## 2. 曲目清单（`web/playlist.json`，按播放顺序）

播放顺序按「轻快开场 → 中段舒缓 → 末段明亮」设计，风格不重复；全部为纯器乐（`pieces.json` 的 instruments 字段无 voice/vocal/singers/choir），时长 1–4 分钟。

| # | 曲名 | 流派 | 时长 | BPM | 情绪（feel） | 体积 | 播放定位 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Happy Alley | Pop | 1:20 | 112 | Bouncy, Bright, Grooving, Uplifting | 3.32 MB | 轻快开场 |
| 2 | Move Forward | Electronica | 1:09 | 111 | Bouncy, Bright, Humorous, Uplifting | 2.77 MB | 游戏感/俏皮 |
| 3 | Neon Laser Horizon | Contemporary | 2:59 | 160 | Grooving, Bright, Uplifting | 3.57 MB | 中段提亮 |
| 4 | The Forest and the Trees | Contemporary | 1:34 | 89 | Bright, Relaxed | 3.77 MB | 舒缓（木管） |
| 5 | Heartwarming | Contemporary | 1:12 | 82 | Bouncy, Bright, Uplifting | 2.97 MB | 舒缓（钢琴） |
| 6 | Surf Shimmy | Rock | 2:03 | 170 | Grooving, Bright, Bouncy | 3.93 MB | 轻快起伏 |
| 7 | Open Those Bright Eyes | Soundtrack | 1:28 | 122 | Bouncy, Bright | 3.53 MB | 明亮收尾 |

合计 **7 首，11 分 45 秒，约 23.87 MB**；单曲最大 **3.93 MB**，均 ≤ 4 MB。

完整直链（与 `playlist.json` 一致）：

```text
https://incompetech.com/music/royalty-free/mp3-royaltyfree/Happy%20Alley.mp3
https://incompetech.com/music/royalty-free/mp3-royaltyfree/Move%20Forward.mp3
https://incompetech.com/music/royalty-free/mp3-royaltyfree/Neon%20Laser%20Horizon.mp3
https://incompetech.com/music/royalty-free/mp3-royaltyfree/The%20Forest%20and%20the%20Trees.mp3
https://incompetech.com/music/royalty-free/mp3-royaltyfree/Heartwarming.mp3
https://incompetech.com/music/royalty-free/mp3-royaltyfree/Surf%20Shimmy.mp3
https://incompetech.com/music/royalty-free/mp3-royaltyfree/Open%20Those%20Bright%20Eyes.mp3
```

## 3. 逐曲署名（页面展示文本）

建议页面直接展示以下单行格式（已包含作者、来源、许可证、许可证链接）：

1. Music: “Happy Alley” — Kevin MacLeod (incompetech.com), CC BY 4.0
2. Music: “Move Forward” — Kevin MacLeod (incompetech.com), CC BY 4.0
3. Music: “Neon Laser Horizon” — Kevin MacLeod (incompetech.com), CC BY 4.0
4. Music: “The Forest and the Trees” — Kevin MacLeod (incompetech.com), CC BY 4.0
5. Music: “Heartwarming” — Kevin MacLeod (incompetech.com), CC BY 4.0
6. Music: “Surf Shimmy” — Kevin MacLeod (incompetech.com), CC BY 4.0
7. Music: “Open Those Bright Eyes” — Kevin MacLeod (incompetech.com), CC BY 4.0

许可证链接统一为 <https://creativecommons.org/licenses/by/4.0/>。

如需一次性完整署名块（例如“关于/版权”页），可整段展示：

```text
"Happy Alley", "Move Forward", "Neon Laser Horizon", "The Forest and the Trees",
"Heartwarming", "Surf Shimmy", "Open Those Bright Eyes"
Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

## 4. 实测证据（本地 + `ssh dev` 国内服务器）

### 测试条件

- 时间：2026-11-08 00:12–00:13（UTC+08:00），本地与本项目 dev 服务器同一组 URL 各测一遍。
- 本地：Windows + `curl.exe`；dev：`ssh dev` 登录国内服务器后执行同样的 `curl`。
- 请求头：Chrome UA + `Referer: https://wkeeli.cn/gomoku/`（同时验证无防盗链拦截）。
  - UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36`
- 判定标准：Range 请求返回 **200/206 + audio/mpeg 或 application/octet-stream + 下载 2048 字节**；HEAD 的 `Content-Length` > 1MB（本次全部 ≤ 4MB 且 > 2.7MB）；`Content-Range` 总大小与 `Content-Length` 一致。

### 实测命令

本地：

```bash
curl -sS -A "<Chrome UA>" -e "https://wkeeli.cn/gomoku/" -r 0-2047 -o NUL -w "%{http_code} %{content_type} %{size_download}\n" "<URL>"
curl -sS -A "<Chrome UA>" -e "https://wkeeli.cn/gomoku/" -I "<URL>"
```

dev（`ssh dev` 内，`-o /dev/null`）：

```bash
curl -sS -A "<Chrome UA>" -e "https://wkeeli.cn/gomoku/" -r 0-2047 -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" "<URL>"
curl -sS -A "<Chrome UA>" -e "https://wkeeli.cn/gomoku/" -I "<URL>"
```

### 结果汇总

| # | 曲目 | local Range | local HEAD | dev Range | dev HEAD | Content-Length（两端一致） | Content-Range 总大小 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Happy Alley | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 3,316,821 | bytes 0-2047/3316821 |
| 2 | Move Forward | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 2,772,289 | 匹配 |
| 3 | Neon Laser Horizon | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 3,573,716 | 匹配 |
| 4 | The Forest and the Trees | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 3,772,033 | 匹配 |
| 5 | Heartwarming | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 2,971,312 | 匹配 |
| 6 | Surf Shimmy | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 3,934,390 | 匹配 |
| 7 | Open Those Bright Eyes | 206 / application/octet-stream / 2048 | 200 | 206 / application/octet-stream / 2048 | 200 | 3,526,447 | 匹配 |

补充校验：7 个文件首字节均为 `49 44 33`（ASCII `ID3`，即带 ID3v2 标签的 MP3）；`Accept-Ranges: bytes`。

### 代表性原始输出（Happy Alley，本地；dev 输出一致）

Range 请求：

```text
206 application/octet-stream 2048
```

HEAD 响应头：

```http
HTTP/1.1 200 OK
Server: Apache/2.4.69 (Debian)
Accept-Ranges: bytes
Content-Length: 3316821
Cache-Control: no-cache, no-store, must-revalidate
Pragma: no-cache
Expires: 0
Content-Disposition: attachment
Content-Type: application/octet-stream
```

带 `Origin: https://wkeeli.cn` 的 Range GET 额外观察：

```text
HTTP/1.1 206 Partial Content
Content-Length: 2048
Content-Range: bytes 0-2047/3316821
Content-Type: application/octet-stream
（无 Access-Control-Allow-Origin 响应头）
```

## 5. 页面署名建议

CC BY 4.0 要求**保留作者署名 + 许可证链接 + 来源**，且署名不能只藏在 JSON/代码注释里。建议三选一（推荐组合使用）：

1. **页脚常驻一行**（最省事）：
   `背景音乐：Kevin MacLeod (incompetech.com)，CC BY 4.0`，`CC BY 4.0` 指向 <https://creativecommons.org/licenses/by/4.0/>，并可链接本文件或“音乐版权”弹窗。
2. **“关于/设置”里的音乐版权面板**（推荐）：列出 7 首曲名 + 每首 `Music: “<Title>” — Kevin MacLeod (incompetech.com), CC BY 4.0`，底部放许可证链接与本文件链接。
3. **播放时显示当前曲目**：在音乐开关旁显示 `♪ <Title> — Kevin MacLeod (incompetech.com), CC BY 4.0`，标题/署名可点击到许可证页。

注意：若页面形态确实无法展示署名（例如全屏无 UI 的商用展示），应按官方说明购买 Standard License（<https://incompetech.com/music/royalty-free/licenses/>）或移除音乐，不能省略署名。

## 6. 风险与前端降级说明

1. **单点外部依赖**：清单只依赖 incompetech.com 一个域名（按团队前置实测，Pixabay 403、archive.org/Wikimedia 国内不可达，故不采用）。源站不可用或被网络阻断时，`<audio>` 会触发 `error`/`stalled`，前端应捕获并**静默降级为无音乐**，不得阻塞棋局、不得反复重试打满网络。
2. **缓存与流量**：源站返回 `Cache-Control: no-cache, no-store, must-revalidate`，浏览器每次会话都会重新拉取，无法依赖强缓存；已通过选短曲控制单曲 ≤ 4 MB（最大 3.93 MB，7 首合计 ~23.9 MB），降低国移动网络压力。
3. **响应头兼容性**：
   - `Content-Type: application/octet-stream`（非 `audio/mpeg`）：Chrome/Edge/Firefox 会按内容嗅探为 MP3 正常播放；个别浏览器若拒绝，前端需 `onerror` 降级（跳过该曲或关闭音乐）。
   - `Content-Disposition: attachment`：只影响直接导航下载，不影响 `<audio src>` 播放（Range 206 实测正常）。
   - 无 `Access-Control-Allow-Origin`：**不能**用 `fetch` + `decodeAudioData`（Web Audio API 跨域会失败），必须用 `<audio src="...">` 元素播放；也不要给 `<audio>` 加 `crossorigin`，否则可能额外要求 CORS。
4. **防盗链**：带项目站点 `Referer` 实测 200/206，暂无白名单限制；未来若加限制需改用服务端代理或换源。
5. **自动播放策略**：浏览器要求用户手势后才能出声；前端应以「音乐开关/点击开始」启动，并处理 `play()` 被拒绝（Promise reject）的情况，默认不自动播放。
6. **URL 稳定性**：曲名/文件名取自站点当前 `pieces.json`；若未来源站改名或 404，前端应跳过坏曲，`playlist.json` 需重新校对。注意空格必须保持 `%20`、大小写与曲名完全一致，否则会 404。
7. **许可合规**：必须保留第 3/5 节署名；不得把曲目文件下载后随仓库分发（本清单仅外链，未入库）。

## 7. 变更范围

本次只新增/修改以下两个文件，未改前端代码、未改 `server.py`、未 commit：

- `web/playlist.json`（前端 `fetch('./playlist.json')` 使用）
- `web/MUSIC-CREDITS.md`（本文件）
