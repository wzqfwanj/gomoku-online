#!/usr/bin/env python3
"""大富翁核心逻辑单元测试（直接实例化 MonopolyRoom，不依赖 HTTP）。

用法：python tests/test_monopoly.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

PASSED = 0
FAILED = []


def check(name, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s %s" % (name, detail))
        FAILED.append(name)


class Dice:
    """临时替换 random.randint / random.choice，返回预设值。"""

    def __init__(self, rolls=None, choice=None):
        self.rolls = list(rolls or [])
        self.choice = choice

    def __enter__(self):
        self._randint = server.random.randint
        self._choice = server.random.choice
        values = iter(self.rolls)

        def fake_randint(a, b):
            return next(values)

        server.random.randint = fake_randint
        if self.choice is not None:
            server.random.choice = lambda seq: self.choice
        return self

    def __exit__(self, *exc):
        server.random.randint = self._randint
        server.random.choice = self._choice
        return False


def new_room(room_id="TEST01"):
    room = server.MonopolyRoom(room_id)
    black = room.players[server.BLACK].token
    room.join("")
    white = room.players[server.WHITE].token
    room.phase = "roll"
    room.turn = server.BLACK
    room.dice = None
    room.doubles = 0
    return room, black, white


def test_basic():
    print("[1] 初始化 / 加入 / 掷骰移动 / 买地")
    room, black, white = new_room()
    check("初始现金 1500", room.cash == {1: 1500, 2: 1500}, str(room.cash))
    check("初始位置 0", room.pos == {1: 0, 2: 0}, str(room.pos))
    check("棋盘 24 格", len(room.owners) == 24 and len(server.MONO_BOARD) == 24)
    with Dice([3, 4]):
        check("黑方掷骰", room.roll(black) is None)
    check("移动到 7", room.pos[1] == 7, str(room.pos))
    check("进入买地阶段", room.phase == "buy" and room.pending["tile"] == 7, str(room.pending))
    check("落地价 100", server.MONO_BOARD[7]["price"] == 100)
    check("购买成功", room.buy(black, "buy") is None)
    check("业主为黑", room.owners[7] == 1)
    check("扣款 100", room.cash[1] == 1400, str(room.cash))
    check("购买后进入 action", room.phase == "action")
    check("结束回合", room.end_turn(black) is None and room.turn == 2)
    check("非当前玩家不能掷骰", room.roll(black) == "not_your_turn")


def test_pass_go():
    print("[2] 经过起点领工资")
    room, black, _ = new_room()
    room.pos[1] = 20
    room.phase = "roll"
    with Dice([2, 3]):
        room.roll(black)
    check("越过起点 +200", room.cash[1] == 1700, str(room.cash))
    check("新位置 1", room.pos[1] == 1, str(room.pos))
    # 正好落在起点也只领一次 200
    room2, black2, _ = new_room("TEST02")
    room2.pos[1] = 21
    room2.phase = "roll"
    with Dice([1, 2]):
        room2.roll(black2)
    check("落在起点 +200（不重复）", room2.cash[1] == 1700, str(room2.cash))
    check("停在起点", room2.pos[1] == 0, str(room2.pos))


def test_rent():
    print("[3] 租金：基础 / 整组翻倍 / 房屋 / 抵押")
    room, black, _ = new_room()
    room.owners[1] = 2  # 白方持有老城厢（60）
    room.pos[1] = 1
    room.phase = "action"
    room._resolve_landing_locked(1)
    check("基础租金 10", room.cash[1] == 1490, str(room.cash))
    check("租金给白方", room.cash[2] == 1510, str(room.cash))

    room2, black2, _ = new_room("TEST02")
    for i in server.MONO_GROUPS["A"]:
        room2.owners[i] = 2
    room2.pos[1] = 1
    with Dice([0, 0]):
        room2._resolve_landing_locked(1)
    check("整组持有基础租金翻倍 20", room2.cash[1] == 1480, str(room2.cash))

    room3, black3, _ = new_room("TEST03")
    room3.owners[1] = 2
    room3.houses[1] = 3
    room3.pos[1] = 1
    room3._resolve_landing_locked(1)
    check("3 栋房屋租金 70", room3.cash[1] == 1430, str(room3.cash))

    room4, black4, _ = new_room("TEST04")
    room4.owners[1] = 2
    room4.mortgaged[1] = True
    room4.pos[1] = 1
    room4._resolve_landing_locked(1)
    check("抵押中免租", room4.cash[1] == 1500, str(room4.cash))


def test_build_mortgage():
    print("[4] 盖房 / 抵押 / 赎回")
    room, black, _ = new_room()
    room.turn = 1
    room.phase = "action"
    for i in server.MONO_GROUPS["A"]:
        room.owners[i] = 1
    room.cash[1] = 2000
    check("盖房 1 号", room.build(black, 1) is None)
    check("不均匀建造被拒绝", room.build(black, 1) == "invalid_group")
    check("盖房 2 号", room.build(black, 2) is None)
    check("盖到 3 号", room.build(black, 4) is None and room.houses[4] == 1)
    check("盖到 4 号", room.build(black, 5) is None and room.houses[5] == 1)
    for _ in range(4):
        for i in (1, 2, 4, 5):
            room.build(black, i)
    check("最高 5 级（旅馆）", room.houses[1] == 5, str(room.houses[:6]))
    check("满级不能继续", room.build(black, 1) == "invalid_move")
    check("有房不能抵押", room.mortgage(black, 1, "mortgage") == "has_houses")
    room.owners[7] = 1
    before = room.cash[1]
    check("抵押 7 号", room.mortgage(black, 7, "mortgage") is None and room.mortgaged[7])
    check("抵押得 50", room.cash[1] == before + 50, str(room.cash[1] - before))
    check("赎回 7 号", room.mortgage(black, 7, "unmortgage") is None and not room.mortgaged[7])
    check("赎回花 55", room.cash[1] == before - 5, str(room.cash[1] - before))


def test_jail():
    print("[5] 监狱：缴保释 / 出狱卡 / 掷双数 / 三次失败")
    room, black, white = new_room()
    room.jail[1] = True
    room.phase = "roll"
    check("缴保释出狱", room.jail_action(black, "pay") is None and not room.jail[1])
    check("保释金 50", room.cash[1] == 1450, str(room.cash))
    room.jail[1] = True
    room.jail_cards[1] = 1
    check("使用出狱卡", room.jail_action(black, "card") is None and not room.jail[1])
    check("出狱卡消耗", room.jail_cards[1] == 0)
    room.jail[1] = True
    check("无卡不能使用", room.jail_action(black, "card") == "no_card")
    room.jail[1] = False

    room2, black2, white2 = new_room("TEST02")
    room2.jail[1] = True
    room2.phase = "roll"
    with Dice([2, 2]):
        room2.roll(black2)
    check("双数出狱并移动", not room2.jail[1] and room2.pos[1] == 4, str(room2.pos))

    room3, black3, white3 = new_room("TEST03")
    room3.jail[1] = True
    room3.jail_turns[1] = 2
    room3.phase = "roll"
    with Dice([2, 3]):
        room3.roll(black3)
    check("第三次失败缴 50 出狱", not room3.jail[1] and room3.cash[1] == 1450, str(room3.cash))
    check("出狱后移动", room3.pos[1] == 5, str(room3.pos))


def test_doubles():
    print("[6] 双数与三次双数入狱")
    room, black, white = new_room()
    with Dice([1, 1]):
        room.roll(black)
    if room.phase == "buy":
        room.buy(black, "pass")
    check("双数可再掷", room.phase == "roll" and room.doubles == 1, room.phase)
    with Dice([2, 2]):
        room.roll(black)
    if room.phase == "buy":
        room.buy(black, "pass")
    check("第二次双数", room.phase == "roll" and room.doubles == 2, room.phase)
    with Dice([3, 3]):
        room.roll(black)
    check("三次双数进监狱", room.jail[1] is True and room.turn == 2, str(room.jail))


def test_chance():
    print("[7] 机会卡")
    room, black, _ = new_room()
    room.turn = 1
    room.phase = "roll"
    room.pos[1] = 3
    for card in server.MONO_CHANCE_CARDS:
        room.cash[1] = 1000
        room.pos[1] = 3
        room.jail[1] = False
        room.jail_cards[1] = 0
        room.winner = 0
        with Dice(choice=card):
            status = room._draw_chance_locked(1)
        if card["text"].startswith("银行分红"):
            check("分红 +100", room.cash[1] == 1100)
        elif card["text"].startswith("缴纳所得税"):
            check("所得税 -100", room.cash[1] == 900)
        elif card["text"].startswith("前进到起点"):
            check("回到起点 +200", room.pos[1] == 0 and room.cash[1] == 1200)
        elif card["text"].startswith("被警察"):
            check("机会卡进监狱", status == "ended" and room.jail[1] and room.turn == 2)
            room.turn = 1
        elif card["text"].startswith("获得一张"):
            check("获得出狱卡", room.jail_cards[1] == 1)
        elif card["text"].startswith("房屋维修"):
            check("维修费", room.cash[1] == 1000)
        elif card["text"].startswith("中了彩票"):
            check("彩票 +150", room.cash[1] == 1150)
        elif card["text"].startswith("交通罚单"):
            check("罚单 -50", room.cash[1] == 950)


def test_bankrupt_restart():
    print("[8] 破产 / 重开")
    room, black, white = new_room()
    room.owners[23] = 2
    room.houses[23] = 5
    room.pos[1] = 23
    room.cash[1] = 10
    room.phase = "action"
    room._resolve_landing_locked(1)
    check("破产判负", room.winner == 2 and room.phase == "over", str(room.winner))
    check("胜者收走余款", room.cash[2] == 1510, str(room.cash))
    room.restart(black)
    room.restart(white)
    check("重开清空", room.cash == {1: 1500, 2: 1500} and room.pos == {1: 0, 2: 0})
    check("重开业主清空", all(v == 0 for v in room.owners))
    check("重开黑先", room.turn == 1 and room.phase == "roll" and room.winner == 0)
    check("重开房屋清空", all(v == 0 for v in room.houses))


def test_state_json():
    print("[9] state 可序列化")
    room, black, _ = new_room()
    state = room._state_locked()
    text = json.dumps(state, ensure_ascii=False)
    check("state JSON", isinstance(text, str) and len(text) > 100)
    check("state 含 board 24", len(state["board"]) == 24)
    check("state 含 owners 24", len(state["owners"]) == 24)
    check("state phase", state["phase"] == "buy" or state["phase"] in ("roll", "action", "waiting", "over"))


def main():
    test_basic()
    test_pass_go()
    test_rent()
    test_build_mortgage()
    test_jail()
    test_doubles()
    test_chance()
    test_bankrupt_restart()
    test_state_json()
    print()
    if FAILED:
        print("失败 %d 项: %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("全部通过 ✔（%d 项）" % PASSED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
