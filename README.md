# 五子棋 · Gomoku Online

极简黑白风格的联网五子棋，浏览器打开即可与朋友对战。

- 在线地址：<https://wkeeli.cn/gomoku/>
- 规则：15 × 15 棋盘，黑先，横/竖/斜任意方向连成 5 子获胜，棋盘下满为平局
- 功能：创建 / 加入房间（6 位房号）、分享链接、观战、再来一局、断线重连、明暗主题切换

## 技术栈

| 层 | 实现 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript，Canvas 绘制棋盘，无构建、无第三方依赖 |
| 后端 | Python 3 标准库 `http.server`，SSE（Server-Sent Events）实时推送，内存房间状态，零第三方依赖 |
| 部署 | systemd 托管 Python 服务，Caddy 子路径反向代理 |

服务端是唯一的规则裁判：房间、落子合法性、胜负判定全部在服务端完成，客户端只负责渲染。

## 本地运行

```bash
python server.py                 # 默认 0.0.0.0:8086
python server.py --port 9000     # 指定端口
```

打开 <http://127.0.0.1:8086/> 即可。两个浏览器窗口分别创建 / 加入同一房间即可对战。

## 测试

```bash
python tests/test_api.py --port 8086   # 需先启动服务
```

覆盖建房、加入、观战、轮次校验、五连判胜、终局、再来一局、断线重连等 38 项断言。

## 目录结构

```
server.py          后端服务（HTTP API + SSE + 静态文件）
web/               前端页面（index.html / style.css / app.js / favicon.svg）
tests/test_api.py  API 冒烟测试
deploy/            部署配置（systemd unit、Caddy 路由片段、部署说明）
```

## HTTP / SSE 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/room` | 创建房间，返回房号、玩家 token（执黑） |
| POST | `/api/join` | 加入房间，返回颜色（1 黑 / 2 白 / 0 观战）；带 token 可重连 |
| POST | `/api/move` | 落子 `{roomId, token, x, y}` |
| POST | `/api/restart` | 切换「再来一局」就绪状态，双方就绪后重开 |
| GET | `/api/stream?room=&token=` | SSE 状态流，事件名 `state` |

部署在子路径（如 `/gomoku/`）时，前端一律使用相对路径，后端无需感知前缀。

## 部署

见 [deploy/README.md](deploy/README.md)。

## 已知限制（最小实现）

- 公开访问，无账号体系与限流；若被刷房间，可在应用层加房间/连接上限。
- 房间状态保存在内存中，服务重启即丢局；房间 2 小时无活动自动回收。
- 断线检测在约 1 秒内发现，再经 3 秒去抖后通知对手（约 4 秒）；SSE 另每 15 秒发一次心跳保活。
- SSE 的玩家 token 通过查询参数传递，会进入反向代理/服务访问日志（公开小游戏，风险可接受）。
- 采用自由规则：5 子及以上连珠即胜，无禁手。

## License

[MIT](LICENSE)
