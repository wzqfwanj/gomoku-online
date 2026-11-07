#!/usr/bin/env python3
"""五子棋联网游戏服务端 —— 最小实现。

只用 Python 标准库（http.server + SSE），零第三方依赖。

用法:
    python server.py                # 监听 0.0.0.0:8086
    python server.py --port 9000
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import secrets
import select
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------- 常量

SIZE = 15                     # 棋盘 15x15
EMPTY, BLACK, WHITE, DRAW = 0, 1, 2, 3
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # 去掉易混字符 O/0/I/1
ROOM_TTL = 2 * 60 * 60        # 房间 2 小时无活动后回收
DISCONNECT_GRACE = 3.0        # 断线后延迟 3 秒再广播，避免网络抖动闪烁
MAX_BODY = 64 * 1024

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


def log(message: str) -> None:
    sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), message))
    sys.stderr.flush()


# ---------------------------------------------------------------- 数据模型

class Player:
    __slots__ = ("token", "ready")

    def __init__(self, token: str) -> None:
        self.token = token
        self.ready = False


class Room:
    """一局房间。所有公开方法内部加锁；SSE 订阅者共享同一个状态快照。"""

    def __init__(self, room_id: str) -> None:
        self.id = room_id
        self.lock = threading.RLock()
        self.board = [EMPTY] * (SIZE * SIZE)
        self.turn = BLACK
        self.winner = 0
        self.win_line = None
        self.last_move = None
        self.moves = 0
        # color -> Player | None（黑方在创建时就有）
        self.players: dict[int, Player | None] = {BLACK: Player(secrets.token_hex(16)), WHITE: None}
        self.subscribers: list[tuple[queue.Queue, str]] = []
        self.created = time.time()
        self.last_activity = time.time()

    # -- 内部辅助 -------------------------------------------------

    def _touch(self) -> None:
        self.last_activity = time.time()

    def _player_color(self, token: str) -> int | None:
        if not token:
            return None
        for color, player in self.players.items():
            if player is not None and player.token == token:
                return color
        return None

    def _subscriber_count(self, token: str) -> int:
        return sum(1 for _, t in self.subscribers if token and t == token)

    def _spectator_count(self) -> int:
        player_tokens = {p.token for p in self.players.values() if p is not None}
        return sum(1 for _, t in self.subscribers if t not in player_tokens)

    def _state_locked(self) -> dict:
        return {
            "room": self.id,
            "size": SIZE,
            "board": list(self.board),
            "turn": self.turn,
            "winner": self.winner,
            "winLine": self.win_line,
            "lastMove": self.last_move,
            "players": {
                "black": {
                    "connected": self._subscriber_count(self.players[BLACK].token if self.players[BLACK] else "") > 0,
                    "ready": bool(self.players[BLACK] and self.players[BLACK].ready),
                },
                "white": {
                    "connected": self._subscriber_count(self.players[WHITE].token if self.players[WHITE] else "") > 0,
                    "ready": bool(self.players[WHITE] and self.players[WHITE].ready),
                },
            },
            "spectators": self._spectator_count(),
            "moves": self.moves,
        }

    def _broadcast_locked(self) -> None:
        payload = "event: state\ndata: %s\n\n" % json.dumps(
            self._state_locked(), ensure_ascii=False, separators=(",", ":")
        )
        for box, _token in list(self.subscribers):
            try:
                box.put_nowait(payload)
            except queue.Full:
                # 丢最旧的快照，保证客户端最终拿到最新状态
                try:
                    box.get_nowait()
                    box.put_nowait(payload)
                except queue.Empty:
                    pass

    def _delayed_broadcast(self) -> None:
        def run() -> None:
            with self.lock:
                self._broadcast_locked()

        timer = threading.Timer(DISCONNECT_GRACE, run)
        timer.daemon = True
        timer.start()

    # -- SSE 订阅 -------------------------------------------------

    def attach(self, box: queue.Queue, token: str) -> None:
        with self.lock:
            self.subscribers.append((box, token))
            self._touch()
            self._broadcast_locked()   # 新连接立刻收到当前状态

    def detach(self, box: queue.Queue) -> None:
        with self.lock:
            self.subscribers = [(b, t) for (b, t) in self.subscribers if b is not box]
            self._touch()
        self._delayed_broadcast()      # 延迟广播，避免瞬时断线导致对手看到闪烁

    # -- 玩家动作 -------------------------------------------------

    def join(self, token: str) -> tuple[int, str | None]:
        """返回 (color, token)。color=0 表示观战。"""
        with self.lock:
            color = self._player_color(token)
            if color is not None:
                self._touch()
                return color, token
            if self.players[WHITE] is None:
                new_token = secrets.token_hex(16)
                self.players[WHITE] = Player(new_token)
                self._touch()
                self._broadcast_locked()
                return WHITE, new_token
            self._touch()
            return 0, None

    def move(self, token: str, x: int, y: int) -> str | None:
        """返回 None 表示成功，否则返回错误码。"""
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner != 0:
                return "game_over"
            if self.turn != color:
                return "not_your_turn"
            if not (0 <= x < SIZE and 0 <= y < SIZE):
                return "invalid_move"
            index = y * SIZE + x
            if self.board[index] != EMPTY:
                return "invalid_move"
            self.board[index] = color
            self.moves += 1
            self.last_move = {"x": x, "y": y, "color": color}
            self.turn = WHITE if color == BLACK else BLACK
            line = self._win_line(x, y, color)
            if line is not None:
                self.winner = color
                self.win_line = line
                self.turn = color
            elif self.moves >= SIZE * SIZE:
                self.winner = DRAW
                self.turn = color
            self._touch()
            self._broadcast_locked()
            return None

    def restart(self, token: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            # 只允许终局后「再来一局」，避免对局中被单方清盘
            if self.winner == 0:
                return "game_not_over"
            player = self.players[color]
            player.ready = not player.ready
            both_ready = (
                self.players[BLACK] is not None
                and self.players[WHITE] is not None
                and self.players[BLACK].ready
                and self.players[WHITE].ready
            )
            if both_ready:
                self.board = [EMPTY] * (SIZE * SIZE)
                self.turn = BLACK
                self.winner = 0
                self.win_line = None
                self.last_move = None
                self.moves = 0
                self.players[BLACK].ready = False
                self.players[WHITE].ready = False
            self._touch()
            self._broadcast_locked()
            return None

    def _win_line(self, x: int, y: int, color: int) -> list[list[int]] | None:
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            line = [[x, y]]
            nx, ny = x + dx, y + dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and self.board[ny * SIZE + nx] == color:
                line.append([nx, ny])
                nx, ny = nx + dx, ny + dy
            nx, ny = x - dx, y - dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and self.board[ny * SIZE + nx] == color:
                line.insert(0, [nx, ny])
                nx, ny = nx - dx, ny - dy
            if len(line) >= 5:
                return line
        return None


# ---------------------------------------------------------------- 房间注册表

ROOMS: dict[str, Room] = {}
ROOMS_LOCK = threading.Lock()


def create_room() -> Room:
    with ROOMS_LOCK:
        while True:
            room_id = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
            if room_id not in ROOMS:
                room = Room(room_id)
                ROOMS[room_id] = room
                return room


def get_room(room_id: str) -> Room | None:
    with ROOMS_LOCK:
        return ROOMS.get(room_id)


def room_count() -> int:
    with ROOMS_LOCK:
        return len(ROOMS)


def cleaner_loop() -> None:
    """后台回收长时间无活动的房间。"""
    while True:
        time.sleep(300)
        cutoff = time.time() - ROOM_TTL
        with ROOMS_LOCK:
            expired = [rid for rid, room in ROOMS.items() if room.last_activity < cutoff]
            for rid in expired:
                del ROOMS[rid]
        if expired:
            log("回收过期房间: %s" % ", ".join(expired))


# ---------------------------------------------------------------- HTTP 处理

class GomokuServer(ThreadingHTTPServer):
    """HTTP 服务器；客户端刷新/关页造成的断连属正常现象，不打印 traceback。"""

    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Gomoku/1.0"

    # -- 工具 -----------------------------------------------------

    def _read_body(self) -> bytes | None:
        """读取并消费请求体。

        HTTP/1.1 keep-alive 下必须把请求体读干净，否则残留字节会被当成
        下一条请求的请求行（例如 "{}GET ..." → 501）。
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            return None
        if length <= 0:
            return b""
        if length > MAX_BODY:
            self.close_connection = True
            return None
        try:
            return self.rfile.read(length)
        except OSError:
            self.close_connection = True
            return None

    @staticmethod
    def _parse_json(raw: bytes) -> dict | None:
        if not raw:
            return None
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str) -> None:
        self._send_json(status, {"error": code})

    # -- 路由 -----------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/stream":
            self._handle_stream(parsed.query)
        elif path == "/api/health":
            self._send_json(200, {"ok": True, "rooms": room_count()})
        else:
            self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        # 不支持 chunked：避免残留 chunk 字节污染 keep-alive 下的下一条请求
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._error(400, "bad_request")
            return
        parsed = urlparse(self.path)
        raw = self._read_body()
        if raw is None:
            self._error(400, "bad_request")
            return
        if parsed.path == "/api/room":
            self._handle_room()
            return
        data = self._parse_json(raw)
        if data is None:
            self._error(400, "bad_request")
            return
        try:
            if parsed.path == "/api/join":
                self._handle_join(data)
            elif parsed.path == "/api/move":
                self._handle_move(data)
            elif parsed.path == "/api/restart":
                self._handle_restart(data)
            else:
                self._error(404, "not_found")
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # -- 静态文件 -------------------------------------------------

    def _serve_static(self, path: str) -> None:
        entry = STATIC_FILES.get(path)
        if entry is None:
            self._error(404, "not_found")
            return
        filename, content_type = entry
        filepath = os.path.join(WEB_DIR, filename)
        try:
            with open(filepath, "rb") as handle:
                body = handle.read()
        except OSError:
            log("缺少静态文件: %s" % filepath)
            self._error(404, "not_found")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:  # noqa: N802
        if STATIC_FILES.get(urlparse(self.path).path) is not None:
            self._serve_static(urlparse(self.path).path)
        else:
            self._error(404, "not_found")

    # -- API 实现 -------------------------------------------------

    @staticmethod
    def _room_token(data: dict) -> tuple[str, str]:
        room_id = str(data.get("roomId") or "").strip().upper()
        token = str(data.get("token") or "").strip()
        return room_id, token

    def _handle_room(self) -> None:
        room = create_room()
        black = room.players[BLACK]
        assert black is not None
        log("创建房间 %s" % room.id)
        self._send_json(200, {"roomId": room.id, "token": black.token, "color": BLACK})

    def _handle_join(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = get_room(room_id)
        if room is None:
            self._error(404, "room_not_found")
            return
        color, new_token = room.join(token)
        log("加入房间 %s -> color=%d" % (room_id, color))
        self._send_json(200, {"roomId": room_id, "token": new_token, "color": color})

    def _handle_move(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = get_room(room_id)
        if room is None:
            self._error(404, "room_not_found")
            return
        x, y = data.get("x"), data.get("y")
        if type(x) is not int or type(y) is not int:
            self._error(400, "invalid_move")
            return
        error = room.move(token, x, y)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_restart(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = get_room(room_id)
        if room is None:
            self._error(404, "room_not_found")
            return
        error = room.restart(token)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    # -- SSE ------------------------------------------------------

    def _handle_stream(self, query: str) -> None:
        params = parse_qs(query)
        room_id = (params.get("room") or [""])[0].strip().upper()
        token = (params.get("token") or [""])[0].strip()
        room = get_room(room_id)
        if room is None:
            self._error(404, "room_not_found")
            return

        box: queue.Queue = queue.Queue(maxsize=128)
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        room.attach(box, token)
        last_ping = time.time()
        try:
            while True:
                try:
                    payload = box.get(timeout=1.0)
                except queue.Empty:
                    # 主动探测对端关闭：客户端刷新/关页时无需等 15s 心跳写失败
                    if self._peer_closed():
                        break
                    now = time.time()
                    if now - last_ping >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = now
                    continue
                self.wfile.write(payload.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            room.detach(box)

    def _peer_closed(self) -> bool:
        """非阻塞检查 SSE 连接是否已被对端关闭。"""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    # -- 日志 -----------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if self.path.startswith("/api/stream"):
            return
        log("%s %s" % (self.address_string(), fmt % args))


# ---------------------------------------------------------------- 入口

def main() -> None:
    parser = argparse.ArgumentParser(description="五子棋联网游戏服务端")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--port", type=int, default=8086, help="监听端口（默认 8086）")
    args = parser.parse_args()

    threading.Thread(target=cleaner_loop, name="room-cleaner", daemon=True).start()

    server = GomokuServer((args.host, args.port), Handler)
    log("五子棋服务已启动: http://%s:%d/ （已有房间 %d 个）" % (args.host, args.port, room_count()))

    def shutdown(_signum, _frame) -> None:
        log("收到退出信号，正在关闭…")
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("已退出")


if __name__ == "__main__":
    main()
