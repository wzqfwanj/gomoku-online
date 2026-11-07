#!/usr/bin/env python3
"""五子棋服务端 API 冒烟测试（不依赖第三方库）。

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

    def latest(self):
        with self.lock:
            return self.states[-1] if self.states else None

    def count(self):
        with self.lock:
            return len(self.states)

    def wait_for(self, predicate, timeout=5.0, label="state", since=0):
        """等待从第 since 帧之后新到达、且满足条件的帧（历史帧不参与匹配）。"""
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


def main():
    global PORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    PORT = args.port

    print("[1] 创建房间")
    status, created = post("/api/room")
    check("创建房间 200", status == 200, str(status))
    room = created["roomId"]
    black = created["token"]
    check("房号 6 位", len(room) == 6, room)
    check("创建者执黑", created["color"] == 1, str(created["color"]))

    print("[2] 加入校验")
    status, body = post("/api/join", {"roomId": "ZZZZZZ"})
    check("不存在的房间 404", status == 404 and body.get("error") == "room_not_found", str(body))
    status, white_join = post("/api/join", {"roomId": room})
    check("第二人执白", status == 200 and white_join["color"] == 2, str(white_join))
    white = white_join["token"]
    status, spectator = post("/api/join", {"roomId": room})
    check("第三人观战", status == 200 and spectator["color"] == 0, str(spectator))
    status, rejoin = post("/api/join", {"roomId": room, "token": black})
    check("带 token 重连保持黑方", rejoin["color"] == 1 and rejoin["token"] == black, str(rejoin))

    print("[3] SSE 状态流")
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

    print("[5] 五连获胜")
    sequence = [
        (white, 0, 1), (black, 1, 0), (white, 1, 1), (black, 2, 0),
        (white, 2, 1), (black, 3, 0), (white, 3, 1), (black, 4, 0),
    ]
    for token, x, y in sequence:
        status, body = post("/api/move", {"roomId": room, "token": token, "x": x, "y": y})
        check("落子 (%d,%d)" % (x, y), status == 200, str(body))
    state = black_sse.wait_for(lambda s: s["winner"] == 1)
    check("黑方五连获胜", state["winner"] == 1)
    check("胜利连线 5 点", state["winLine"] is not None and len(state["winLine"]) >= 5, str(state.get("winLine")))
    check("手数 9", state["moves"] == 9, str(state["moves"]))
    status, body = post("/api/move", {"roomId": room, "token": black, "x": 10, "y": 10})
    check("终局落子 400 game_over", body.get("error") == "game_over", str(body))
    white_state = white_sse.wait_for(lambda s: s["winner"] == 1)
    check("白方同步终局", white_state["winner"] == 1)

    print("[6] 再来一局")
    post("/api/restart", {"roomId": room, "token": black})
    state = black_sse.wait_for(lambda s: s["players"]["black"]["ready"] is True)
    check("黑方就绪", state["players"]["black"]["ready"] is True and state["winner"] == 1)
    post("/api/restart", {"roomId": room, "token": white})
    state = black_sse.wait_for(lambda s: s["winner"] == 0 and sum(s["board"]) == 0)
    check("双方就绪后重开", state["turn"] == 1 and state["moves"] == 0)
    check("重开后清空就绪标记", state["players"]["black"]["ready"] is False and state["players"]["white"]["ready"] is False)

    print("[7] 断线与重连")
    # 服务端用 select 主动探测对端关闭（≤1s）+ 3s 去抖广播，故 12s 足够
    mark = black_sse.count()
    white_sse.close()
    state = black_sse.wait_for(lambda s: s["players"]["white"]["connected"] is False, timeout=12, since=mark)
    check("白方断线标记", state["players"]["white"]["connected"] is False)
    mark = black_sse.count()
    white_sse = SSEClient(room, white)
    state = black_sse.wait_for(lambda s: s["players"]["white"]["connected"] is True, timeout=8, since=mark)
    check("白方重连恢复", state["players"]["white"]["connected"] is True)

    print("[8] 静态与健康检查")
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    conn.request("GET", "/api/health")
    resp = conn.getresponse()
    health = json.loads(resp.read())
    conn.close()
    check("健康检查", resp.status == 200 and health.get("ok") is True, str(health))

    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    conn.request("GET", "/playlist.json")
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    playlist = json.loads(raw.decode("utf-8")) if resp.status == 200 else {}
    tracks = playlist.get("tracks") if isinstance(playlist, dict) else None
    check(
        "播放列表 200 且合法",
        resp.status == 200 and isinstance(tracks, list) and len(tracks) >= 5
        and all(str(t.get("url", "")).startswith("https://") for t in tracks),
        "status=%s tracks=%s" % (resp.status, len(tracks) if isinstance(tracks, list) else tracks),
    )

    print("[9] 不支持 chunked 请求")
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

    for client in (black_sse, white_sse, spec_sse):
        client.close()

    print()
    if FAILED:
        print("失败 %d 项: %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("全部通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
