#!/usr/bin/env python3
"""联机小游戏平台 API 冒烟测试（五子棋 + 连连看，不依赖第三方库）。

用法：先启动服务 python server.py --port 8086，再运行
    python tests/test_api.py [--port 8086]
"""

import argparse
import http.client
import json
import sys
import threading
import time

HOST = "127.0.0.1"
PORT = 8086
FAILED = []


def check(name, condition, detail=""):
    if condition:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s %s" % (name, detail))
        FAILED.append(name)


def post(path, payload=None):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    body = json.dumps(payload if payload is not None else {}).encode("utf-8")
    conn.request("POST", path, body=body, headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    return resp.status, (json.loads(raw.decode("utf-8")) if raw else None)


def get(path):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    conn.request("GET", path)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        data = None
    return resp.status, data


class SSEClient:
    def __init__(self, room, token):
        self.room = room
        self.token = token
        self.states = []
        self.lock = threading.Lock()
        self.stop = False
        self.conn = http.client.HTTPConnection(HOST, PORT, timeout=20)
        self.conn.request("GET", "/api/stream?room=%s&token=%s" % (room, token or ""))
        self.resp = self.conn.getresponse()
        assert self.resp.status == 200, "SSE 状态码 %s" % self.resp.status
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop:
            try:
                line = self.resp.readline()
            except Exception:
                break
            if not line:
                break
            text = line.decode("utf-8").strip()
            if text.startswith("data: "):
                try:
                    state = json.loads(text[6:])
                except json.JSONDecodeError:
                    continue
                with self.lock:
                    self.states.append(state)

    def count(self):
        with self.lock:
            return len(self.states)

    def wait_for(self, predicate, timeout=5.0, label="state", since=0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for state in reversed(self.states[since:]):
                    if predicate(state):
                        return state
            time.sleep(0.02)
        raise AssertionError("SSE 等待超时: %s" % label)

    def close(self):
        self.stop = True
        try:
            self.resp.close()
            self.conn.close()
        except Exception:
            pass


def gomoku_flow():
    print("[1] 创建五子棋房间")
    status, created = post("/api/room", {"game": "gomoku"})
    check("创建房间 200", status == 200, str(status))
    room = created["roomId"]
    black = created["token"]
    check("房号 6 位", len(room) == 6, room)
    check("创建者执黑", created["color"] == 1, str(created["color"]))
    check("游戏类型 gomoku", created.get("game") == "gomoku", str(created.get("game")))

    print("[2] 加入 / 观战 / 重连")
    status, body = post("/api/join", {"roomId": "ZZZZZZ"})
    check("不存在房间 404", status == 404 and body.get("error") == "room_not_found", str(body))
    status, white_join = post("/api/join", {"roomId": room})
    check("第二人执白", status == 200 and white_join["color"] == 2, str(white_join))
    check("加入返回 game", white_join.get("game") == "gomoku", str(white_join.get("game")))
    white = white_join["token"]
    status, spectator = post("/api/join", {"roomId": room})
    check("第三人观战", status == 200 and spectator["color"] == 0, str(spectator))
    status, rejoin = post("/api/join", {"roomId": room, "token": black})
    check("带 token 重连保持黑方", rejoin["color"] == 1 and rejoin["token"] == black, str(rejoin))

    print("[3] SSE 初始状态")
    black_sse = SSEClient(room, black)
    white_sse = SSEClient(room, white)
    spec_sse = SSEClient(room, "")
    state = black_sse.wait_for(lambda s: s["players"]["black"]["connected"])
    check("黑方连接标记", state["players"]["black"]["connected"] is True)
    state = black_sse.wait_for(lambda s: s["players"]["white"]["connected"])
    check("白方连接标记", state["players"]["white"]["connected"] is True)
    state = black_sse.wait_for(lambda s: s["spectators"] == 1)
    check("观战者计数", state["spectators"] == 1, str(state["spectators"]))
    check("初始棋盘 225 格", len(state["board"]) == 225 and sum(state["board"]) == 0)
    check("黑先", state["turn"] == 1 and state["winner"] == 0)
    check("初始比分 0:0", state["score"] == {"black": 0, "white": 0}, str(state.get("score")))
    check("初始悔棋次数 3/3", state["undoLeft"] == {"black": 3, "white": 3}, str(state.get("undoLeft")))
    check("初始无悔棋请求", state.get("undoRequest") is None, str(state.get("undoRequest")))

    print("[4] 落子合法性")
    status, body = post("/api/move", {"roomId": room, "token": white, "x": 0, "y": 0})
    check("白方抢下 400 not_your_turn", body.get("error") == "not_your_turn", str(body))
    status, body = post("/api/move", {"roomId": room, "token": spectator.get("token") or "", "x": 0, "y": 0})
    check("观战者落子 400 not_player", body.get("error") == "not_player", str(body))
    status, body = post("/api/move", {"roomId": room, "token": black, "x": 15, "y": 0})
    check("越界 400 invalid_move", body.get("error") == "invalid_move", str(body))
    status, body = post("/api/move", {"roomId": room, "token": black, "x": "0", "y": 0})
    check("非整数 400 invalid_move", body.get("error") == "invalid_move", str(body))
    status, body = post("/api/move", {"roomId": room, "token": black, "x": 0, "y": 0})
    check("黑方落子成功", status == 200 and body.get("ok") is True, str(body))
    status, body = post("/api/restart", {"roomId": room, "token": black})
    check("对局中不可重开 400 game_not_over", body.get("error") == "game_not_over", str(body))
    status, body = post("/api/move", {"roomId": room, "token": white, "x": 0, "y": 0})
    check("重复落子 400 invalid_move", body.get("error") == "invalid_move", str(body))

    print("[5] 悔棋（请求 → 对方同意）")
    status, body = post("/api/undo", {"roomId": room, "token": black, "action": "request"})
    check("黑方请求悔棋", status == 200 and body.get("ok") is True, str(body))
    state = white_sse.wait_for(lambda s: s.get("undoRequest") == {"color": 1}, label="悔棋请求广播")
    check("对方收到悔棋请求", state.get("undoRequest") == {"color": 1}, str(state.get("undoRequest")))
    status, body = post("/api/undo", {"roomId": room, "token": black, "action": "request"})
    check("重复请求 400 request_pending", body.get("error") == "request_pending", str(body))
    status, body = post("/api/undo", {"roomId": room, "token": white, "action": "reject"})
    check("对方拒绝悔棋", status == 200, str(body))
    state = black_sse.wait_for(lambda s: s.get("undoRequest") is None)
    check("拒绝后清除请求", state.get("undoRequest") is None)
    post("/api/undo", {"roomId": room, "token": black, "action": "request"})
    status, body = post("/api/undo", {"roomId": room, "token": white, "action": "accept"})
    check("对方同意悔棋", status == 200, str(body))
    state = black_sse.wait_for(lambda s: s["moves"] == 0 and sum(s["board"]) == 0)
    check("悔棋撤销最近一手", state["moves"] == 0 and sum(state["board"]) == 0)
    check("悔棋后轮到黑方", state["turn"] == 1)
    check("黑方剩余悔棋 2 次", state["undoLeft"]["black"] == 2, str(state["undoLeft"]))
    status, body = post("/api/undo", {"roomId": room, "token": black, "action": "request"})
    check("无棋可悔 400 no_undo", body.get("error") == "no_undo", str(body))
    status, body = post("/api/undo", {"roomId": room, "token": spectator.get("token") or "", "action": "request"})
    check("观战者不能悔棋 400 not_player", body.get("error") == "not_player", str(body))

    print("[6] 五连获胜与比分")
    sequence = [
        (black, 0, 0), (white, 0, 1), (black, 1, 0), (white, 1, 1),
        (black, 2, 0), (white, 2, 1), (black, 3, 0), (white, 3, 1), (black, 4, 0),
    ]
    for index, (token, x, y) in enumerate(sequence):
        status, body = post("/api/move", {"roomId": room, "token": token, "x": x, "y": y})
        check("落子 #%d (%d,%d)" % (index + 1, x, y), status == 200, str(body))
    state = black_sse.wait_for(lambda s: s["winner"] == 1)
    check("黑方五连获胜", state["winner"] == 1)
    check("胜利连线 5 点", state["winLine"] is not None and len(state["winLine"]) >= 5, str(state.get("winLine")))
    check("手数 9", state["moves"] == 9, str(state["moves"]))
    check("比分累计 1:0", state["score"] == {"black": 1, "white": 0}, str(state.get("score")))
    status, body = post("/api/move", {"roomId": room, "token": black, "x": 10, "y": 10})
    check("终局落子 400 game_over", body.get("error") == "game_over", str(body))
    status, body = post("/api/undo", {"roomId": room, "token": black, "action": "request"})
    check("终局不能悔棋 400 game_over", body.get("error") == "game_over", str(body))
    white_state = white_sse.wait_for(lambda s: s["winner"] == 1)
    check("白方同步终局", white_state["winner"] == 1)

    print("[7] 再来一局：比分保留、悔棋次数重置")
    post("/api/restart", {"roomId": room, "token": black})
    state = black_sse.wait_for(lambda s: s["players"]["black"]["ready"] is True)
    check("黑方就绪", state["players"]["black"]["ready"] is True and state["winner"] == 1)
    post("/api/restart", {"roomId": room, "token": white})
    state = black_sse.wait_for(lambda s: s["winner"] == 0 and sum(s["board"]) == 0)
    check("双方就绪后重开", state["turn"] == 1 and state["moves"] == 0)
    check("重开后清空就绪", state["players"]["black"]["ready"] is False and state["players"]["white"]["ready"] is False)
    check("比分跨局保留 1:0", state["score"] == {"black": 1, "white": 0}, str(state.get("score")))
    check("悔棋次数重置 3/3", state["undoLeft"] == {"black": 3, "white": 3}, str(state.get("undoLeft")))

    print("[8] 断线与重连")
    mark = black_sse.count()
    white_sse.close()
    state = black_sse.wait_for(lambda s: s["players"]["white"]["connected"] is False, timeout=12, since=mark)
    check("白方断线标记", state["players"]["white"]["connected"] is False)
    mark = black_sse.count()
    white_sse = SSEClient(room, white)
    state = black_sse.wait_for(lambda s: s["players"]["white"]["connected"] is True, timeout=8, since=mark)
    check("白方重连恢复", state["players"]["white"]["connected"] is True)

    for client in (black_sse, white_sse, spec_sse):
        client.close()
    return room


def lianliankan_flow():
    print("[9] 创建连连看房间")
    status, created = post("/api/room", {"game": "lianliankan"})
    check("创建连连看房间 200", status == 200, str(status))
    room = created["roomId"]
    black = created["token"]
    check("创建者执黑", created["color"] == 1)
    check("game 字段为 lianliankan", created.get("game") == "lianliankan", str(created.get("game")))
    status, white_join = post("/api/join", {"roomId": room})
    white = white_join["token"]
    check("第二人加入", status == 200 and white_join["color"] == 2, str(white_join))
    status, spectator = post("/api/join", {"roomId": room})
    check("第三人观战", status == 200 and spectator["color"] == 0, str(spectator))

    black_sse = SSEClient(room, black)
    white_sse = SSEClient(room, white)
    spec_sse = SSEClient(room, "")
    state = black_sse.wait_for(lambda s: s["game"] == "lianliankan" and s["players"]["black"]["connected"])
    check("state.game", state["game"] == "lianliankan")
    check("双方棋盘各 64 格", len(state["boards"]["black"]) == 64 and len(state["boards"]["white"]) == 64)
    black_types = sorted(v for v in state["boards"]["black"] if v)
    check("黑方棋盘 16 种图案各 4 枚", len(set(black_types)) == 16
          and all(black_types.count(t) == 4 for t in set(black_types)))
    check("初始 cleared 0", state["cleared"] == {"black": 0, "white": 0}, str(state["cleared"]))
    check("totalPairs=32", state["totalPairs"] == 32, str(state.get("totalPairs")))
    spec_state = spec_sse.wait_for(lambda s: s["spectators"] == 1)
    check("观战者能看到双方棋盘", len(spec_state["boards"]["black"]) == 64 and len(spec_state["boards"]["white"]) == 64)

    print("[10] 五子棋接口在连连看房间返回 wrong_game")
    status, body = post("/api/move", {"roomId": room, "token": black, "x": 0, "y": 0})
    check("move 到连连看房间 400 wrong_game", body.get("error") == "wrong_game", str(body))
    status, body = post("/api/undo", {"roomId": room, "token": black, "action": "request"})
    check("undo 到连连看房间 400 wrong_game", body.get("error") == "wrong_game", str(body))

    print("[11] 连连看配对 / 提示 / 胜负")
    status, hint = post("/api/hint", {"roomId": room, "token": black})
    check("提示返回一对坐标", status == 200 and all(k in hint for k in ("x1", "y1", "x2", "y2")), str(hint))
    steps = 0
    while True:
        status, hint = post("/api/hint", {"roomId": room, "token": black})
        if status != 200:
            check("提示失败（第 %d 步）" % steps, False, str(hint))
            break
        status, body = post("/api/match", {
            "roomId": room, "token": black,
            "x1": hint["x1"], "y1": hint["y1"], "x2": hint["x2"], "y2": hint["y2"],
        })
        if status != 200:
            check("配对失败（第 %d 步）" % steps, False, str(body))
            break
        steps += 1
        if steps > 40:
            check("不能无限配对", False, "超过 40 步")
            break
        state = black_sse.wait_for(lambda s: s["cleared"]["black"] == steps, label="消除同步")
        if state["winner"] == 1:
            break
    check("清空 32 对", steps == 32, "steps=%d" % steps)
    check("黑方获胜", state["winner"] == 1, str(state.get("winner")))
    check("黑方 cleared=32", state["cleared"]["black"] == 32, str(state["cleared"]))
    check("白方棋盘不受影响", state["cleared"]["white"] == 0, str(state["cleared"]))
    status, body = post("/api/hint", {"roomId": room, "token": black})
    check("终局提示 400 game_over", body.get("error") == "game_over", str(body))
    status, body = post("/api/match", {"roomId": room, "token": black, "x1": 0, "y1": 0, "x2": 0, "y2": 1})
    check("终局配对 400 game_over", body.get("error") == "game_over", str(body))

    print("[12] 连连看重开")
    status, body = post("/api/restart", {"roomId": room, "token": black})
    check("黑方就绪", status == 200, str(body))
    status, body = post("/api/restart", {"roomId": room, "token": white})
    check("白方就绪", status == 200, str(body))
    state = black_sse.wait_for(lambda s: s["winner"] == 0 and s["cleared"] == {"black": 0, "white": 0})
    check("重开后 cleared 归零", state["cleared"] == {"black": 0, "white": 0})
    check("重开后新棋盘 64 格", len(state["boards"]["black"]) == 64)

    for client in (black_sse, white_sse, spec_sse):
        client.close()
    return room


def misc_flow():
    print("[13] 静态与健康检查")
    status, health = get("/api/health")
    check("健康检查", status == 200 and health.get("ok") is True, str(health))
    status, playlist = get("/playlist.json")
    tracks = playlist.get("tracks") if isinstance(playlist, dict) else None
    check("播放列表 200 且合法", status == 200 and isinstance(tracks, list) and len(tracks) >= 5,
          "status=%s tracks=%s" % (status, len(tracks) if isinstance(tracks, list) else tracks))

    print("[14] 不支持 chunked 请求")
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    conn.request(
        "POST",
        "/api/room",
        body=iter([b"{}"]),
        headers={"Content-Type": "application/json"},
        encode_chunked=True,
    )
    resp = conn.getresponse()
    body = resp.read()
    check("chunked 请求 400", resp.status == 400 and b"bad_request" in body, "%s %s" % (resp.status, body))
    conn.close()
    status, body = post("/api/room")
    check("chunked 拒绝后连接仍正常", status == 200 and len(body.get("roomId", "")) == 6, str(body))


def main():
    global PORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    PORT = args.port

    gomoku_flow()
    lianliankan_flow()
    misc_flow()

    print()
    if FAILED:
        print("失败 %d 项: %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("全部通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
