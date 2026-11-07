#!/usr/bin/env python3
"""联机小游戏平台服务端 —— 五子棋 + 连连看。

只用 Python 标准库（http.server + SSE），零第三方依赖。

用法:
    python server.py                # 监听 0.0.0.0:8086
    python server.py --port 9000
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import queue
import random
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

GOMOKU = "gomoku"
LIANLIAN = "lianliankan"
MONOPOLY = "monopoly"
GAMES = (GOMOKU, LIANLIAN, MONOPOLY)

SIZE = 15                     # 五子棋棋盘
EMPTY, BLACK, WHITE, DRAW = 0, 1, 2, 3

LLK_SIZE = 8                  # 连连看棋盘 8x8
LLK_TYPES = 16                # 图案种类
LLK_PAIRS = LLK_SIZE * LLK_SIZE // 2   # 32 对

# ---------------------------------------------------------------- 大富翁

MONO_START_CASH = 1500
MONO_GO_SALARY = 200
MONO_JAIL_FINE = 50
MONO_TAX = 100
MONO_MAX_LEVEL = 5            # 4 栋房屋 + 1 座旅馆
MONO_JAIL_ATTEMPTS = 3

MONO_GROUP_COLORS = {"A": "#b07a4a", "B": "#5b9bd5", "C": "#e07aa8", "D": "#e0a03c"}

# 24 格环形棋盘：角格 0/6/12/18，其余为地产 / 机会 / 税
MONO_BOARD = [
    {"type": "go", "name": "起点"},
    {"type": "property", "name": "老城厢", "group": "A", "price": 60},
    {"type": "property", "name": "城隍庙", "group": "A", "price": 60},
    {"type": "chance", "name": "机会"},
    {"type": "property", "name": "豫园", "group": "A", "price": 80},
    {"type": "property", "name": "外滩", "group": "A", "price": 80},
    {"type": "jail", "name": "监狱"},
    {"type": "property", "name": "南京路", "group": "B", "price": 100},
    {"type": "property", "name": "淮海路", "group": "B", "price": 100},
    {"type": "tax", "name": "缴税"},
    {"type": "property", "name": "新天地", "group": "B", "price": 120},
    {"type": "property", "name": "陆家嘴", "group": "B", "price": 140},
    {"type": "free", "name": "免费停车"},
    {"type": "property", "name": "西湖", "group": "C", "price": 180},
    {"type": "property", "name": "灵隐寺", "group": "C", "price": 180},
    {"type": "chance", "name": "机会"},
    {"type": "property", "name": "千岛湖", "group": "C", "price": 200},
    {"type": "property", "name": "黄山", "group": "C", "price": 220},
    {"type": "gotojail", "name": "进监狱"},
    {"type": "property", "name": "故宫", "group": "D", "price": 280},
    {"type": "property", "name": "长城", "group": "D", "price": 280},
    {"type": "tax", "name": "缴税"},
    {"type": "property", "name": "颐和园", "group": "D", "price": 320},
    {"type": "property", "name": "兵马俑", "group": "D", "price": 350},
]
MONO_BOARD_SIZE = len(MONO_BOARD)

MONO_GROUPS: dict[str, list[int]] = {}
for _i, _tile in enumerate(MONO_BOARD):
    if _tile["type"] == "property":
        MONO_GROUPS.setdefault(_tile["group"], []).append(_i)

MONO_CHANCE_CARDS = [
    {"text": "银行分红，获得 $100", "money": 100},
    {"text": "缴纳所得税 $100", "money": -100},
    {"text": "前进到起点，领取 $200", "go": True},
    {"text": "被警察送进监狱", "jail": True},
    {"text": "获得一张「出狱许可」", "card": True},
    {"text": "房屋维修：每栋房屋支付 $25", "repair": 25},
    {"text": "中了彩票，获得 $150", "money": 150},
    {"text": "交通罚单，支付 $50", "money": -50},
]

MONO_BOARD_STATE = []
for _tile in MONO_BOARD:
    _entry = dict(_tile)
    if _entry["type"] == "property":
        _entry["color"] = MONO_GROUP_COLORS[_entry["group"]]
    else:
        _entry["color"] = ""
    _entry.setdefault("group", "")
    _entry.setdefault("price", 0)
    MONO_BOARD_STATE.append(_entry)


def mono_house_cost(price: int) -> int:
    return max(50, (price // 2) // 10 * 10)


def mono_mortgage_value(price: int) -> int:
    return price // 2


def mono_unmortgage_cost(price: int) -> int:
    return (price * 55 + 99) // 100


def mono_rent(price: int, level: int) -> int:
    """基础租金按房屋等级递增；level=0..5，5 为旅馆。"""
    base = max(10, price // 10)
    table = (1, 2, 4, 7, 10, 15)
    return base * table[min(level, MONO_MAX_LEVEL)]


UNDO_LIMIT = 3                # 每人每局悔棋次数

ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_TTL = 2 * 60 * 60
DISCONNECT_GRACE = 3.0
HEARTBEAT = 15.0
MAX_BODY = 64 * 1024

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/llk.js": ("llk.js", "text/javascript; charset=utf-8"),
    "/llk.css": ("llk.css", "text/css; charset=utf-8"),
    "/monopoly.js": ("monopoly.js", "text/javascript; charset=utf-8"),
    "/monopoly.css": ("monopoly.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    "/playlist.json": ("playlist.json", "application/json; charset=utf-8"),
}


def log(message: str) -> None:
    sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), message))
    sys.stderr.flush()


# ---------------------------------------------------------------- 玩家 / 房间基类

class Player:
    __slots__ = ("token", "ready")

    def __init__(self, token: str) -> None:
        self.token = token
        self.ready = False


class Room:
    """房间公共部分：玩家、订阅者、比分、就绪/重开、SSE 广播。"""

    game = ""

    def __init__(self, room_id: str) -> None:
        self.id = room_id
        self.lock = threading.RLock()
        self.players: dict[int, Player | None] = {BLACK: Player(secrets.token_hex(16)), WHITE: None}
        self.subscribers: list[tuple[queue.Queue, str]] = []
        self.score = {BLACK: 0, WHITE: 0}      # 五子棋跨局比分（连连看不使用）
        self.winner = 0
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
        state = {
            "room": self.id,
            "game": self.game,
            "winner": self.winner,
            "score": {"black": self.score[BLACK], "white": self.score[WHITE]},
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
        }
        state.update(self.extra_state_locked())
        return state

    def extra_state_locked(self) -> dict:
        return {}

    def _broadcast_locked(self) -> None:
        payload = "event: state\ndata: %s\n\n" % json.dumps(
            self._state_locked(), ensure_ascii=False, separators=(",", ":")
        )
        for box, _token in list(self.subscribers):
            try:
                box.put_nowait(payload)
            except queue.Full:
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
            self._broadcast_locked()

    def detach(self, box: queue.Queue) -> None:
        with self.lock:
            self.subscribers = [(b, t) for (b, t) in self.subscribers if b is not box]
            self._touch()
        self._delayed_broadcast()

    # -- 玩家动作 -------------------------------------------------

    def join(self, token: str) -> tuple[int, str | None]:
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

    def restart(self, token: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
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
                self.players[BLACK].ready = False
                self.players[WHITE].ready = False
                self.winner = 0
                self._reset_locked()
            self._touch()
            self._broadcast_locked()
            return None

    def _reset_locked(self) -> None:
        """新一局：子类重置各自棋局状态（比分不重置）。"""


# ---------------------------------------------------------------- 五子棋

class GomokuRoom(Room):
    game = GOMOKU

    def __init__(self, room_id: str) -> None:
        super().__init__(room_id)
        self.board = [EMPTY] * (SIZE * SIZE)
        self.turn = BLACK
        self.win_line = None
        self.last_move = None
        self.moves = 0
        self.history: list[tuple[int, int, int]] = []
        self.undo_request: int | None = None
        self.undo_left = {BLACK: UNDO_LIMIT, WHITE: UNDO_LIMIT}

    def _reset_locked(self) -> None:
        self.board = [EMPTY] * (SIZE * SIZE)
        self.turn = BLACK
        self.win_line = None
        self.last_move = None
        self.moves = 0
        self.history = []
        self.undo_request = None
        self.undo_left = {BLACK: UNDO_LIMIT, WHITE: UNDO_LIMIT}

    def extra_state_locked(self) -> dict:
        return {
            "size": SIZE,
            "board": list(self.board),
            "turn": self.turn,
            "winLine": self.win_line,
            "lastMove": self.last_move,
            "moves": self.moves,
            "undoRequest": ({"color": self.undo_request} if self.undo_request else None),
            "undoLeft": {"black": self.undo_left[BLACK], "white": self.undo_left[WHITE]},
        }

    def move(self, token: str, x: int, y: int) -> str | None:
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
            self.history.append((x, y, color))
            self.last_move = {"x": x, "y": y, "color": color}
            self.undo_request = None
            self.turn = WHITE if color == BLACK else BLACK
            line = self._win_line(x, y, color)
            if line is not None:
                self.winner = color
                self.win_line = line
                self.turn = color
                self.score[color] += 1
            elif self.moves >= SIZE * SIZE:
                self.winner = DRAW
                self.turn = color
            self._touch()
            self._broadcast_locked()
            return None

    def undo(self, token: str, action: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if action == "request":
                if self.winner != 0:
                    return "game_over"
                if self.undo_request is not None:
                    return "request_pending"
                if not self.history:
                    return "no_undo"
                if self.history[-1][2] != color:
                    return "unavailable"
                if self.undo_left[color] <= 0:
                    return "no_undo"
                self.undo_request = color
                self._touch()
                self._broadcast_locked()
                return None
            if action == "cancel":
                if self.undo_request != color:
                    return "no_request"
                self.undo_request = None
                self._touch()
                self._broadcast_locked()
                return None
            if action in ("accept", "reject"):
                if self.undo_request is None:
                    return "no_request"
                if self.undo_request == color:
                    return "no_request"
                if action == "reject":
                    self.undo_request = None
                    self._touch()
                    self._broadcast_locked()
                    return None
                requester = self.undo_request
                x, y, last_color = self.history.pop()
                self.board[y * SIZE + x] = EMPTY
                self.moves -= 1
                self.turn = last_color
                self.undo_left[requester] -= 1
                self.win_line = None
                self.winner = 0
                if self.history:
                    px, py, pc = self.history[-1]
                    self.last_move = {"x": px, "y": py, "color": pc}
                else:
                    self.last_move = None
                self.undo_request = None
                self._touch()
                self._broadcast_locked()
                return None
            return "bad_request"

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


# ---------------------------------------------------------------- 连连看

def _llk_empty(board: list[int], size: int, x: int, y: int) -> bool:
    """棋盘外的一圈视为空位（连连看允许绕出边界），棋盘内按内容判断。"""
    if x < 0 or x >= size or y < 0 or y >= size:
        return True
    return board[y * size + x] == 0


def _llk_straight(board: list[int], size: int, ax: int, ay: int, bx: int, by: int) -> bool:
    """两点同行/同列，且中间（不含端点）全空。"""
    if ax == bx:
        lo, hi = sorted((ay, by))
        return all(_llk_empty(board, size, ax, y) for y in range(lo + 1, hi))
    if ay == by:
        lo, hi = sorted((ax, bx))
        return all(_llk_empty(board, size, x, ay) for x in range(lo + 1, hi))
    return False


def _llk_one_turn(board: list[int], size: int, a: tuple[int, int], b: tuple[int, int]) -> bool:
    """两点之间用 0 或 1 个折点连通。"""
    ax, ay = a
    bx, by = b
    if _llk_straight(board, size, ax, ay, bx, by):
        return True
    for cx, cy in ((ax, by), (bx, ay)):
        if (cx, cy) in (a, b):
            continue
        if _llk_empty(board, size, cx, cy) and _llk_straight(board, size, ax, ay, cx, cy) \
                and _llk_straight(board, size, cx, cy, bx, by):
            return True
    return False


def llk_can_connect(board: list[int], size: int, a: tuple[int, int], b: tuple[int, int]) -> bool:
    """同类型两枚图案能否用 <=2 个折点的路径连通（可绕棋盘外）。"""
    ax, ay = a
    bx, by = b
    if a == b:
        return False
    if _llk_one_turn(board, size, a, b):
        return True
    # 两个折点：先从 a 直线走到某格 c，再 c -> b 至多一折
    for cx in range(-1, size + 1):
        c = (cx, ay)
        if c in (a, b):
            continue
        if _llk_empty(board, size, cx, ay) and _llk_straight(board, size, ax, ay, cx, ay) \
                and _llk_one_turn(board, size, c, b):
            return True
    for cy in range(-1, size + 1):
        c = (ax, cy)
        if c in (a, b):
            continue
        if _llk_empty(board, size, ax, cy) and _llk_straight(board, size, ax, ay, ax, cy) \
                and _llk_one_turn(board, size, c, b):
            return True
    return False


def llk_find_pair(board: list[int], size: int) -> tuple[tuple[int, int], tuple[int, int]] | None:
    groups: dict[int, list[tuple[int, int]]] = {}
    for y in range(size):
        for x in range(size):
            value = board[y * size + x]
            if value:
                groups.setdefault(value, []).append((x, y))
    for cells in groups.values():
        for i in range(len(cells)):
            for j in range(i + 1, len(cells)):
                if llk_can_connect(board, size, cells[i], cells[j]):
                    return cells[i], cells[j]
    return None


def llk_generate_board() -> list[int]:
    """生成一块保证可解的连连看棋盘。

    做法：在「满棋盘」上模拟按顺序消对——每步只挑当前仍连通的同色位（这里先不考虑
    颜色，只确定位置），记录消去顺序；最后把记录的顺序映射成随机图案类型。
    因为每个位置对在「轮到它消去时」确实连通，所以这局一定有解。
    收尾固定保留一对相邻格（相邻必连通），避免最后两格连不上。
    """
    size = LLK_SIZE
    all_cells = [(x, y) for y in range(size) for x in range(size)]
    reserved = [(0, 0), (0, 1)]          # 最后消的一对，天然相邻
    remaining = [c for c in all_cells if c not in reserved]

    for _attempt in range(200):
        sim = [1] * (size * size)        # 1 = 该位置还有棋子
        cells = list(remaining)
        pairs: list[tuple[tuple[int, int], tuple[int, int]]] = []
        ok = True
        for _step in range(LLK_PAIRS - 1):
            random.shuffle(cells)
            found = None
            for i in range(len(cells)):
                ai = cells[i]
                for j in range(i + 1, len(cells)):
                    bj = cells[j]
                    if llk_can_connect(sim, size, ai, bj):
                        found = (ai, bj)
                        break
                if found is not None:
                    break
            if found is None:
                ok = False
                break
            a, b = found
            pairs.append((a, b))
            sim[a[1] * size + a[0]] = 0
            sim[b[1] * size + b[0]] = 0
            cells.remove(a)
            cells.remove(b)
        if not ok:
            continue
        pairs.append((reserved[0], reserved[1]))
        types = [t for t in range(1, LLK_TYPES + 1)] * 2
        random.shuffle(types)
        board = [0] * (size * size)
        for i, (a, b) in enumerate(pairs):
            board[a[1] * size + a[0]] = types[i]
            board[b[1] * size + b[0]] = types[i]
        return board
    raise RuntimeError("无法生成可解连连看棋盘")


class LianliankanRoom(Room):
    game = LIANLIAN

    def __init__(self, room_id: str) -> None:
        super().__init__(room_id)
        self.boards = {BLACK: llk_generate_board(), WHITE: llk_generate_board()}
        self.cleared = {BLACK: 0, WHITE: 0}
        self.total_pairs = LLK_PAIRS
        self.last_clear = None

    def _reset_locked(self) -> None:
        self.boards = {BLACK: llk_generate_board(), WHITE: llk_generate_board()}
        self.cleared = {BLACK: 0, WHITE: 0}
        self.last_clear = None

    def extra_state_locked(self) -> dict:
        return {
            "size": LLK_SIZE,
            "boards": {
                "black": list(self.boards[BLACK]),
                "white": list(self.boards[WHITE]),
            },
            "cleared": {"black": self.cleared[BLACK], "white": self.cleared[WHITE]},
            "totalPairs": self.total_pairs,
            "winner": self.winner,
            "lastClear": self.last_clear,
        }

    def match(self, token: str, x1: int, y1: int, x2: int, y2: int) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner != 0:
                return "game_over"
            if not all(0 <= v < LLK_SIZE for v in (x1, y1, x2, y2)):
                return "invalid_move"
            if (x1, y1) == (x2, y2):
                return "invalid_move"
            board = self.boards[color]
            i1 = y1 * LLK_SIZE + x1
            i2 = y2 * LLK_SIZE + x2
            if board[i1] == 0 or board[i2] == 0:
                return "invalid_move"
            if board[i1] != board[i2]:
                return "no_match"
            if not llk_can_connect(board, LLK_SIZE, (x1, y1), (x2, y2)):
                return "no_match"
            board[i1] = 0
            board[i2] = 0
            self.cleared[color] += 1
            self.last_clear = {"color": color, "x1": x1, "y1": y1, "x2": x2, "y2": y2}
            if self.cleared[color] >= self.total_pairs:
                self.winner = color
            self._touch()
            self._broadcast_locked()
            return None

    def hint(self, token: str) -> dict | str:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner != 0:
                return "game_over"
            pair = llk_find_pair(self.boards[color], LLK_SIZE)
            if pair is None:
                # 玩家自己消出了死局：自动重排剩余图案一次，保证还能继续
                pair = self._reshuffle_locked(color)
                if pair is None:
                    return "no_hint"
                self._touch()
                self._broadcast_locked()
            a, b = pair
            return {"x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]}

    def shuffle(self, token: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner != 0:
                return "game_over"
            pair = self._reshuffle_locked(color)
            if pair is None:
                return "no_hint"
            self.last_clear = None
            self._touch()
            self._broadcast_locked()
            return None

    def _reshuffle_locked(self, color: int):
        """把该玩家剩余图案重新随机排布，找到一个有解的局面。"""
        board = self.boards[color]
        positions = [i for i, value in enumerate(board) if value]
        types = [board[i] for i in positions]
        for _ in range(300):
            random.shuffle(types)
            for pos, value in zip(positions, types):
                board[pos] = value
            pair = llk_find_pair(board, LLK_SIZE)
            if pair is not None:
                return pair
        return None



def mono_action(fn):
    """大富翁动作装饰器：成功（无错误码）后广播最新 state。"""

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        with self.lock:
            result = fn(self, *args, **kwargs)
            if result is None:
                self._touch()
                self._broadcast_locked()
            return result

    return wrapper


class MonopolyRoom(Room):
    """双人大富翁（完整简化版）：掷骰/买地/收租/盖房/抵押/监狱/机会卡/破产。"""
    game = MONOPOLY

    def __init__(self, room_id: str) -> None:
        super().__init__(room_id)
        self.started = False
        self._reset_game_locked()

    # -- 生命周期 -------------------------------------------------

    def _reset_locked(self) -> None:
        self._reset_game_locked()

    def _reset_game_locked(self) -> None:
        self.cash = {BLACK: MONO_START_CASH, WHITE: MONO_START_CASH}
        self.pos = {BLACK: 0, WHITE: 0}
        self.jail = {BLACK: False, WHITE: False}
        self.jail_turns = {BLACK: 0, WHITE: 0}
        self.jail_cards = {BLACK: 0, WHITE: 0}
        self.owners = [0] * MONO_BOARD_SIZE
        self.houses = [0] * MONO_BOARD_SIZE
        self.mortgaged = [False] * MONO_BOARD_SIZE
        self.turn = BLACK
        self.phase = "roll"
        self.dice = None
        self.doubles = 0
        self.pending = None
        self.log: list[str] = []
        self.winner = 0
        self.started = self.players[WHITE] is not None
        self._log("新一局开始，黑方先掷骰")

    def join(self, token: str) -> tuple[int, str | None]:
        with self.lock:
            color, new_token = super().join(token)
            if color == WHITE and not self.started:
                self.started = True
                self.phase = "roll"
                self._log("对手已加入，对局开始，黑方先行")
                self._broadcast_locked()
            return color, new_token

    # -- 工具 -----------------------------------------------------

    def _name(self, color: int) -> str:
        return "黑方" if color == BLACK else "白方"

    @staticmethod
    def _other(color: int) -> int:
        return WHITE if color == BLACK else BLACK

    def _log(self, message: str) -> None:
        self.log.append(message)
        if len(self.log) > 10:
            self.log = self.log[-10:]

    def _is_property(self, index: int) -> bool:
        return 0 <= index < MONO_BOARD_SIZE and MONO_BOARD[index]["type"] == "property"

    def _group_owned(self, color: int, group: str) -> bool:
        return all(self.owners[i] == color for i in MONO_GROUPS[group])

    def _can_end_turn_locked(self) -> bool:
        if self.phase == "action":
            return True
        return self.phase == "roll" and self.dice is not None and self.pending is None

    def _next_turn_locked(self) -> None:
        nxt = self._other(self.turn)
        self.turn = nxt
        self.phase = "roll"
        self.dice = None
        self.doubles = 0
        self.pending = None
        self._log("轮到%s%s" % (self._name(nxt), "（在监狱中）" if self.jail[nxt] else ""))

    # -- 状态 -----------------------------------------------------

    def extra_state_locked(self) -> dict:
        if self.players[WHITE] is None:
            phase = "waiting"
        elif self.winner:
            phase = "over"
        else:
            phase = self.phase
        pending = None
        if self.pending:
            tile = MONO_BOARD[self.pending["tile"]]
            pending = {"type": "buy", "tile": self.pending["tile"], "price": tile["price"]}
        return {
            "turn": self.turn,
            "phase": phase,
            "dice": self.dice,
            "doubles": self.doubles,
            "pending": pending,
            "cash": {"black": self.cash[BLACK], "white": self.cash[WHITE]},
            "pos": {"black": self.pos[BLACK], "white": self.pos[WHITE]},
            "jail": {"black": self.jail[BLACK], "white": self.jail[WHITE]},
            "jailTurns": {"black": self.jail_turns[BLACK], "white": self.jail_turns[WHITE]},
            "jailCards": {"black": self.jail_cards[BLACK], "white": self.jail_cards[WHITE]},
            "owners": list(self.owners),
            "houses": list(self.houses),
            "mortgaged": list(self.mortgaged),
            "board": MONO_BOARD_STATE,
            "canEndTurn": (phase != "waiting" and not self.winner and self._can_end_turn_locked()),
            "log": list(self.log),
        }

    # -- 金钱 / 清算 ----------------------------------------------

    def _charge_locked(self, payer: int, amount: int, recipient: int | None = None) -> bool:
        """扣款；不足时自动卖房/抵押；仍不足则破产。返回是否支付成功。"""
        if amount <= 0:
            return True
        if self.cash[payer] < amount:
            self._liquidate_locked(payer, amount)
        if self.cash[payer] < amount:
            winner = self._other(payer)
            if recipient:
                self.cash[recipient] += self.cash[payer]
            self.cash[payer] = 0
            self.winner = winner
            self.phase = "over"
            self.pending = None
            self._log("%s 破产，%s 获胜！" % (self._name(payer), self._name(winner)))
            return False
        self.cash[payer] -= amount
        if recipient:
            self.cash[recipient] += amount
        return True

    def _liquidate_locked(self, color: int, target: int) -> None:
        while self.cash[color] < target:
            candidates = [
                i for i in range(MONO_BOARD_SIZE)
                if self.owners[i] == color and self.houses[i] > 0
            ]
            if not candidates:
                break
            index = max(candidates, key=lambda i: self.houses[i])
            self.houses[index] -= 1
            price = MONO_BOARD[index]["price"]
            self.cash[color] += mono_house_cost(price) // 2
            self._log("%s 变卖「%s」一处房产" % (self._name(color), MONO_BOARD[index]["name"]))
        while self.cash[color] < target:
            candidates = [
                i for i in range(MONO_BOARD_SIZE)
                if self.owners[i] == color and self.houses[i] == 0 and not self.mortgaged[i]
            ]
            if not candidates:
                break
            index = candidates[0]
            self.mortgaged[index] = True
            price = MONO_BOARD[index]["price"]
            self.cash[color] += mono_mortgage_value(price)
            self._log("%s 抵押「%s」换取现金" % (self._name(color), MONO_BOARD[index]["name"]))

    # -- 移动 / 落地 ----------------------------------------------

    def _move_locked(self, color: int, steps: int) -> None:
        old = self.pos[color]
        total = old + steps
        # 只有「越过」起点（非正好落在起点）时在这里发工资；落在起点由落地逻辑发放
        if steps > 0 and total > MONO_BOARD_SIZE:
            self.cash[color] += MONO_GO_SALARY
            self._log("%s 经过起点，领取 $%d" % (self._name(color), MONO_GO_SALARY))
        self.pos[color] = total % MONO_BOARD_SIZE

    def _send_to_jail_locked(self, color: int, reason: str) -> None:
        self.pos[color] = 6
        self.jail[color] = True
        self.jail_turns[color] = 0
        if reason:
            self._log(reason)

    def _draw_chance_locked(self, color: int) -> str:
        card = random.choice(MONO_CHANCE_CARDS)
        self._log("机会卡：%s" % card["text"])
        if card.get("money"):
            amount = card["money"]
            if amount > 0:
                self.cash[color] += amount
            elif not self._charge_locked(color, -amount):
                return "over"
        elif card.get("go"):
            self.pos[color] = 0
            self.cash[color] += MONO_GO_SALARY
            self._log("%s 回到起点，领取 $%d" % (self._name(color), MONO_GO_SALARY))
        elif card.get("jail"):
            self._send_to_jail_locked(color, "%s 被送进监狱" % self._name(color))
            self._next_turn_locked()
            return "ended"
        elif card.get("card"):
            self.jail_cards[color] += 1
            self._log("%s 获得一张出狱许可" % self._name(color))
        elif card.get("repair"):
            houses = sum(self.houses[i] for i in range(MONO_BOARD_SIZE) if self.owners[i] == color)
            cost = houses * card["repair"]
            self._log("%s 支付房屋维修费 $%d" % (self._name(color), cost))
            if cost and not self._charge_locked(color, cost):
                return "over"
        return "ok"

    def _resolve_landing_locked(self, color: int) -> str:
        index = self.pos[color]
        tile = MONO_BOARD[index]
        kind = tile["type"]
        if kind == "go":
            self.cash[color] += MONO_GO_SALARY
            self._log("%s 落在起点，领取 $%d" % (self._name(color), MONO_GO_SALARY))
            return "ok"
        if kind == "free":
            self._log("%s 在免费停车场休息" % self._name(color))
            return "ok"
        if kind == "jail":
            self._log("%s 只是来探监" % self._name(color))
            return "ok"
        if kind == "gotojail":
            self._send_to_jail_locked(color, "%s 踩到「进监狱」，被送进监狱" % self._name(color))
            self._next_turn_locked()
            return "ended"
        if kind == "tax":
            self._log("%s 缴纳 $%d 税款" % (self._name(color), MONO_TAX))
            if not self._charge_locked(color, MONO_TAX):
                return "over"
            return "ok"
        if kind == "chance":
            return self._draw_chance_locked(color)

        owner = self.owners[index]
        price = tile["price"]
        if owner == 0:
            self.pending = {"type": "buy", "tile": index}
            self.phase = "buy"
            self._log("%s 可购买「%s」（$%d）" % (self._name(color), tile["name"], price))
            return "buy"
        if owner == color:
            self._log("%s 回到自己的「%s」" % (self._name(color), tile["name"]))
            return "ok"
        if self.mortgaged[index]:
            self._log("「%s」已抵押，无需支付租金" % tile["name"])
            return "ok"
        rent = mono_rent(price, self.houses[index])
        if self.houses[index] == 0 and self._group_owned(owner, tile["group"]):
            rent *= 2
            self._log("整组持有，基础租金翻倍")
        self._log("%s 向%s支付「%s」租金 $%d" % (
            self._name(color), self._name(owner), tile["name"], rent))
        if not self._charge_locked(color, rent, recipient=owner):
            return "over"
        return "ok"

    # -- 玩家动作 -------------------------------------------------

    @mono_action
    def roll(self, token: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.players[WHITE] is None:
                return "invalid_phase"
            if self.winner:
                return "game_over"
            if color != self.turn:
                return "not_your_turn"
            if self.phase != "roll" or self.pending:
                return "invalid_phase"

            d1 = random.randint(1, 6)
            d2 = random.randint(1, 6)
            total = d1 + d2
            self.dice = [d1, d2]
            self._log("%s 掷出 %d + %d = %d%s" % (
                self._name(color), d1, d2, total, "（双数）" if d1 == d2 else ""))

            if self.jail[color]:
                if d1 == d2:
                    self.jail[color] = False
                    self.jail_turns[color] = 0
                    self._log("%s 掷出双数，走出监狱！" % self._name(color))
                    self._move_locked(color, total)
                    status = self._resolve_landing_locked(color)
                    if status in ("ended", "over", "buy"):
                        return None
                    self.phase = "action"
                    return None
                self.jail_turns[color] += 1
                if self.jail_turns[color] >= MONO_JAIL_ATTEMPTS:
                    self._log("%s 三次未掷出双数，缴纳 $%d 保释金出狱" % (
                        self._name(color), MONO_JAIL_FINE))
                    if not self._charge_locked(color, MONO_JAIL_FINE):
                        return None
                    self.jail[color] = False
                    self.jail_turns[color] = 0
                    self._move_locked(color, total)
                    status = self._resolve_landing_locked(color)
                    if status in ("ended", "over", "buy"):
                        return None
                    self.phase = "action"
                    return None
                self._log("%s 未掷出双数，继续留在监狱" % self._name(color))
                self._next_turn_locked()
                return None

            if d1 == d2:
                self.doubles += 1
                if self.doubles >= 3:
                    self._log("%s 连续三次双数，被送进监狱" % self._name(color))
                    self._send_to_jail_locked(color, "")
                    self._next_turn_locked()
                    return None

            self._move_locked(color, total)
            status = self._resolve_landing_locked(color)
            if self.winner or status in ("ended", "buy", "over"):
                return None
            if d1 == d2:
                self.phase = "roll"
                self._log("%s 掷出双数，可再掷一次" % self._name(color))
            else:
                self.phase = "action"
            return None

    @mono_action
    def buy(self, token: str, action: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner:
                return "game_over"
            if color != self.turn:
                return "not_your_turn"
            if self.phase != "buy" or not self.pending:
                return "invalid_phase"
            if action not in ("buy", "pass"):
                return "invalid_move"
            index = self.pending["tile"]
            tile = MONO_BOARD[index]
            if action == "buy":
                if self.cash[color] < tile["price"]:
                    return "cannot_afford"
                self.cash[color] -= tile["price"]
                self.owners[index] = color
                self._log("%s 购买「%s」（$%d）" % (self._name(color), tile["name"], tile["price"]))
            else:
                self._log("%s 放弃购买「%s」" % (self._name(color), tile["name"]))
            self.pending = None
            if self.doubles > 0:
                self.phase = "roll"
                self._log("%s 掷出双数，可再掷一次" % self._name(color))
            else:
                self.phase = "action"
            return None

    @mono_action
    def jail_action(self, token: str, action: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner:
                return "game_over"
            if color != self.turn:
                return "not_your_turn"
            if self.phase != "roll":
                return "invalid_phase"
            if not self.jail[color]:
                return "invalid_phase"
            if action == "pay":
                self._log("%s 缴纳 $%d 保释金" % (self._name(color), MONO_JAIL_FINE))
                if not self._charge_locked(color, MONO_JAIL_FINE):
                    return None
                self.jail[color] = False
                self.jail_turns[color] = 0
                return None
            if action == "card":
                if self.jail_cards[color] <= 0:
                    return "no_card"
                self.jail_cards[color] -= 1
                self.jail[color] = False
                self.jail_turns[color] = 0
                self._log("%s 使用出狱许可，走出监狱" % self._name(color))
                return None
            return "invalid_move"

    @mono_action
    def build(self, token: str, index: int) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner:
                return "game_over"
            if color != self.turn:
                return "not_your_turn"
            if self.phase not in ("action", "roll") or self.pending:
                return "invalid_phase"
            if not self._is_property(index):
                return "invalid_move"
            tile = MONO_BOARD[index]
            if self.owners[index] != color:
                return "invalid_move"
            if self.mortgaged[index]:
                return "invalid_move"
            if self.houses[index] >= MONO_MAX_LEVEL:
                return "invalid_move"
            group = tile["group"]
            if not self._group_owned(color, group):
                return "invalid_group"
            min_level = min(self.houses[i] for i in MONO_GROUPS[group])
            if self.houses[index] != min_level:
                return "invalid_group"
            cost = mono_house_cost(tile["price"])
            if self.cash[color] < cost:
                return "cannot_afford"
            self.cash[color] -= cost
            self.houses[index] += 1
            level = self.houses[index]
            label = "旅馆" if level >= MONO_MAX_LEVEL else "%d 栋房屋" % level
            self._log("%s 在「%s」建造%s（$%d）" % (self._name(color), tile["name"], label, cost))
            return None

    @mono_action
    def mortgage(self, token: str, index: int, action: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner:
                return "game_over"
            if color != self.turn:
                return "not_your_turn"
            if self.phase not in ("action", "roll") or self.pending:
                return "invalid_phase"
            if not self._is_property(index):
                return "invalid_move"
            tile = MONO_BOARD[index]
            if self.owners[index] != color:
                return "invalid_move"
            if action == "mortgage":
                if self.mortgaged[index]:
                    return "invalid_move"
                if self.houses[index] > 0:
                    return "has_houses"
                self.mortgaged[index] = True
                self.cash[color] += mono_mortgage_value(tile["price"])
                self._log("%s 抵押「%s」获得 $%d" % (
                    self._name(color), tile["name"], mono_mortgage_value(tile["price"])))
                return None
            if action == "unmortgage":
                if not self.mortgaged[index]:
                    return "invalid_move"
                cost = mono_unmortgage_cost(tile["price"])
                if self.cash[color] < cost:
                    return "cannot_afford"
                self.cash[color] -= cost
                self.mortgaged[index] = False
                self._log("%s 赎回「%s」支付 $%d" % (self._name(color), tile["name"], cost))
                return None
            return "invalid_move"

    @mono_action
    def end_turn(self, token: str) -> str | None:
        with self.lock:
            color = self._player_color(token)
            if color is None:
                return "not_player"
            if self.winner:
                return "game_over"
            if color != self.turn:
                return "not_your_turn"
            if self.pending:
                return "invalid_phase"
            if not self._can_end_turn_locked():
                return "invalid_phase"
            self._next_turn_locked()
            return None


# ---------------------------------------------------------------- 房间注册表

ROOMS: dict[str, Room] = {}
ROOMS_LOCK = threading.Lock()
ROOM_CLASSES = {GOMOKU: GomokuRoom, LIANLIAN: LianliankanRoom, MONOPOLY: MonopolyRoom}


def create_room(game: str) -> Room:
    with ROOMS_LOCK:
        while True:
            room_id = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
            if room_id not in ROOMS:
                room = ROOM_CLASSES[game](room_id)
                ROOMS[room_id] = room
                return room


def get_room(room_id: str) -> Room | None:
    with ROOMS_LOCK:
        return ROOMS.get(room_id)


def room_count() -> int:
    with ROOMS_LOCK:
        return len(ROOMS)


def cleaner_loop() -> None:
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
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GameHub/2.0"

    # -- 工具 -----------------------------------------------------

    def _read_body(self) -> bytes | None:
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

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if STATIC_FILES.get(path) is not None:
            self._serve_static(path)
        else:
            self._error(404, "not_found")

    def do_POST(self) -> None:  # noqa: N802
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
            self._handle_room(self._parse_json(raw) or {})
            return
        data = self._parse_json(raw)
        if data is None:
            self._error(400, "bad_request")
            return
        routes = {
            "/api/join": self._handle_join,
            "/api/move": self._handle_move,
            "/api/match": self._handle_match,
            "/api/hint": self._handle_hint,
            "/api/shuffle": self._handle_shuffle,
            "/api/undo": self._handle_undo,
            "/api/roll": self._handle_mono_roll,
            "/api/buy": self._handle_mono_buy,
            "/api/jail": self._handle_mono_jail,
            "/api/build": self._handle_mono_build,
            "/api/mortgage": self._handle_mono_mortgage,
            "/api/endturn": self._handle_mono_endturn,
            "/api/restart": self._handle_restart,
        }
        handler = routes.get(parsed.path)
        if handler is None:
            self._error(404, "not_found")
            return
        try:
            handler(data)
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

    # -- API 实现 -------------------------------------------------

    @staticmethod
    def _room_token(data: dict) -> tuple[str, str]:
        room_id = str(data.get("roomId") or "").strip().upper()
        token = str(data.get("token") or "").strip()
        return room_id, token

    def _room_or_error(self, room_id: str) -> Room | None:
        room = get_room(room_id)
        if room is None:
            self._error(404, "room_not_found")
        return room

    def _handle_room(self, data: dict) -> None:
        game = str(data.get("game") or GOMOKU).strip().lower()
        if game not in GAMES:
            self._error(400, "invalid_game")
            return
        room = create_room(game)
        black = room.players[BLACK]
        assert black is not None
        log("创建房间 %s (%s)" % (room.id, game))
        self._send_json(200, {"roomId": room.id, "token": black.token, "color": BLACK, "game": game})

    def _handle_join(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return
        color, new_token = room.join(token)
        self._send_json(200, {
            "roomId": room_id,
            "token": new_token,
            "color": color,
            "game": room.game,
        })

    def _handle_move(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return
        if room.game != GOMOKU:
            self._error(400, "wrong_game")
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

    def _handle_match(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return
        if room.game != LIANLIAN:
            self._error(400, "wrong_game")
            return
        coords = [data.get(k) for k in ("x1", "y1", "x2", "y2")]
        if not all(type(v) is int for v in coords):
            self._error(400, "invalid_move")
            return
        error = room.match(token, *coords)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_hint(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return
        if room.game != LIANLIAN:
            self._error(400, "wrong_game")
            return
        result = room.hint(token)
        if isinstance(result, str):
            self._error(400, result)
            return
        self._send_json(200, result)

    def _handle_shuffle(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return
        if room.game != LIANLIAN:
            self._error(400, "wrong_game")
            return
        error = room.shuffle(token)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_undo(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return
        if room.game != GOMOKU:
            self._error(400, "wrong_game")
            return
        action = str(data.get("action") or "").strip().lower()
        error = room.undo(token, action)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _mono_room(self, data: dict) -> tuple[MonopolyRoom | None, str]:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
            return None, token
        if room.game != MONOPOLY:
            self._error(400, "wrong_game")
            return None, token
        return room, token

    def _handle_mono_roll(self, data: dict) -> None:
        room, token = self._mono_room(data)
        if room is None:
            return
        error = room.roll(token)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_mono_buy(self, data: dict) -> None:
        room, token = self._mono_room(data)
        if room is None:
            return
        action = str(data.get("action") or "").strip().lower()
        error = room.buy(token, action)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_mono_jail(self, data: dict) -> None:
        room, token = self._mono_room(data)
        if room is None:
            return
        action = str(data.get("action") or "").strip().lower()
        error = room.jail_action(token, action)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_mono_build(self, data: dict) -> None:
        room, token = self._mono_room(data)
        if room is None:
            return
        tile = data.get("tile")
        if type(tile) is not int:
            self._error(400, "invalid_move")
            return
        error = room.build(token, tile)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_mono_mortgage(self, data: dict) -> None:
        room, token = self._mono_room(data)
        if room is None:
            return
        tile = data.get("tile")
        action = str(data.get("action") or "").strip().lower()
        if type(tile) is not int:
            self._error(400, "invalid_move")
            return
        error = room.mortgage(token, tile, action)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_mono_endturn(self, data: dict) -> None:
        room, token = self._mono_room(data)
        if room is None:
            return
        error = room.end_turn(token)
        if error is not None:
            self._error(400, error)
            return
        self._send_json(200, {"ok": True})

    def _handle_restart(self, data: dict) -> None:
        room_id, token = self._room_token(data)
        room = self._room_or_error(room_id)
        if room is None:
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
        room = self._room_or_error(room_id)
        if room is None:
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
                    if self._peer_closed():
                        break
                    now = time.time()
                    if now - last_ping >= HEARTBEAT:
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
    parser = argparse.ArgumentParser(description="联机小游戏平台服务端")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--port", type=int, default=8086, help="监听端口（默认 8086）")
    args = parser.parse_args()

    threading.Thread(target=cleaner_loop, name="room-cleaner", daemon=True).start()

    server = GomokuServer((args.host, args.port), Handler)
    log("游戏平台已启动: http://%s:%d/ （已有房间 %d 个）" % (args.host, args.port, room_count()))

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
