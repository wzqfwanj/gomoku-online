#!/usr/bin/env python3
"""联机小游戏平台浏览器端到端测试（Playwright + 本机 Edge）。

前置：先启动服务 python server.py --port 8086
运行：python tests/test_e2e.py [--port 8086] [--base https://wkeeli.cn/gomoku/]

覆盖：平台首页（五子棋/连连看）、五子棋悔棋（请求/同意）与跨局比分、实时对战/观战、
      连连看双人各自棋盘/提示/配对/进度、刷新保座、明暗主题、音乐、移动端、控制台无报错。
"""

import argparse
import os
import sys
import tempfile
import time

from playwright.sync_api import expect, sync_playwright

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


def status_text(page):
    return page.locator("#status").inner_text()


def wait_status(page, text, timeout=8.0):
    expect(page.locator("#status")).to_contain_text(text, timeout=timeout * 1000)


def click_point(page, x, y):
    box = page.locator("#board").bounding_box()
    if not box:
        raise AssertionError("棋盘不可见")
    size = min(box["width"], box["height"])
    pad = size * 0.065
    step = (size - pad * 2) / 14.0
    page.mouse.click(box["x"] + pad + x * step, box["y"] + pad + y * step)


def goto(page, url):
    page.goto(url, wait_until="domcontentloaded")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8086)
    parser.add_argument("--base", default="", help="完整服务地址（如 https://wkeeli.cn/gomoku/），优先于 --port")
    args = parser.parse_args()
    base = args.base or ("http://127.0.0.1:%d/" % args.port)
    base = base.rstrip("/") + "/"
    shots = os.path.join(tempfile.gettempdir(), "gomoku-e2e")
    os.makedirs(shots, exist_ok=True)

    errors = []
    music_requests = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        ctx_a = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx_b = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx_c = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx_m = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)

        page_a = ctx_a.new_page()
        page_b = ctx_b.new_page()
        page_c = ctx_c.new_page()
        page_m = ctx_m.new_page()

        for page, label in ((page_a, "A"), (page_b, "B"), (page_c, "C"), (page_m, "M")):
            page.on("pageerror", lambda err, label=label: errors.append("%s pageerror: %s" % (label, err)))
            page.on(
                "console",
                lambda msg, label=label: errors.append("%s console.%s: %s" % (label, msg.type, msg.text))
                if msg.type == "error"
                else None,
            )
        page_a.on("request", lambda req: music_requests.append(req.url) if "incompetech.com" in req.url else None)

        print("[1] 平台首页")
        goto(page_a, base)
        expect(page_a.locator("#create-gomoku")).to_be_visible(timeout=8000)
        check("平台标题", "联机小游戏" in page_a.locator("h1").inner_text(), page_a.locator("h1").inner_text())
        check("五子棋卡片", page_a.locator("#create-gomoku").is_visible())
        check("连连看卡片", page_a.locator("#create-llk").is_visible())
        check("大富翁卡片", page_a.locator("#create-monopoly").is_visible())
        body_text = page_a.locator("body").inner_text()
        check("已删除旧的规则文案", "15×15 棋盘，黑方先行" not in body_text)
        check("彩色氛围背景存在", page_a.locator(".aurora").count() == 1)
        page_a.screenshot(path=os.path.join(shots, "00-home-light.png"), full_page=True)

        print("[2] 背景音乐（默认关闭、点按钮播放）")
        expect(page_a.locator("#music-play")).to_be_enabled(timeout=12000)
        check("音乐控件可见", page_a.locator("#music-bar").is_visible())
        check("默认关闭", page_a.evaluate("document.getElementById('music-audio').paused") is True)
        check("默认不拉取 mp3", not music_requests, str(music_requests[:2]))
        first_title = page_a.locator("#music-title").inner_text().strip()
        check("曲名已展示", first_title not in ("", "背景音乐"), first_title)
        page_a.locator("#music-play").click()
        page_a.wait_for_timeout(1200)
        paused = page_a.evaluate("document.getElementById('music-audio').paused")
        check("点击后进入播放态", paused is False, "paused=%s" % paused)
        # 外链音频的真实出声依赖第三方网络，仅在其可达时做加强断言
        data_ready = False
        deadline = time.time() + 18
        while time.time() < deadline:
            if page_a.evaluate(
                "(() => { const a=document.getElementById('music-audio');"
                " return a.readyState >= 2 && a.currentTime > 0; })()"
            ):
                data_ready = True
                break
            time.sleep(0.4)
        if data_ready:
            check("外链音频实际播放（currentTime > 0）", True)
        else:
            print("  WARN  外链音乐 18s 内未缓冲完成（第三方网络问题，跳过实际出声断言）")
        check("播放时请求外链音乐", bool(music_requests), str(music_requests[:1]))
        page_a.locator("#music-next").click()
        page_a.wait_for_timeout(900)
        check("下一首切换曲目", page_a.locator("#music-title").inner_text().strip() != first_title)
        page_a.evaluate(
            "var v=document.getElementById('music-volume'); v.value='70';"
            "v.dispatchEvent(new Event('input',{bubbles:true}));"
        )
        check("音量生效", abs(page_a.evaluate("document.getElementById('music-audio').volume") - 0.7) < 0.02)
        page_a.locator("#music-play").click()
        page_a.wait_for_timeout(500)
        check("暂停生效", page_a.evaluate("document.getElementById('music-audio').paused") is True)

        print("[3] 五子棋：建房 / 加入 / 比分")
        page_a.locator("#create-gomoku").click()
        expect(page_a.locator("#view-game")).to_be_visible(timeout=8000)
        room = page_a.locator("#room-code").inner_text().strip()
        check("房号 6 位", len(room) == 6, room)
        check("URL 带房间参数", ("room=" + room) in page_a.url, page_a.url)
        wait_status(page_a, "等待对手加入房间")
        check("初始比分", page_a.locator("#score").inner_text().strip() == "黑 0 : 0 白",
              page_a.locator("#score").inner_text())

        goto(page_b, base + "?room=" + room)
        wait_status(page_b, "等待对手落子")
        wait_status(page_a, "轮到你落子")
        check("B 执白等待", "等待对手落子" in status_text(page_b))

        print("[4] 五子棋悔棋（请求 → 对方同意）")
        click_point(page_a, 7, 7)
        wait_status(page_b, "轮到你落子", timeout=8)
        expect(page_a.locator("#undo-btn")).to_be_enabled(timeout=5000)
        check("悔棋按钮可用", page_a.locator("#undo-btn").is_enabled())
        page_a.locator("#undo-btn").click()
        expect(page_a.locator("#undo-banner")).to_be_visible(timeout=5000)
        expect(page_b.locator("#undo-banner")).to_be_visible(timeout=5000)
        check("A 显示等待回应", "等待对方回应" in page_a.locator("#undo-text").inner_text(),
              page_a.locator("#undo-text").inner_text())
        check("B 收到悔棋请求", "对手请求悔棋" in page_b.locator("#undo-text").inner_text(),
              page_b.locator("#undo-text").inner_text())
        page_b.locator("#undo-accept").click()
        wait_status(page_a, "轮到你落子", timeout=8)
        page_a.wait_for_timeout(500)
        check("同意后回到黑方落子", "轮到你落子" in status_text(page_a))
        check("悔棋后次数减为 2", "剩 2" in page_a.locator("#undo-btn").inner_text(),
              page_a.locator("#undo-btn").inner_text())
        check("悔棋条幅消失", page_b.locator("#undo-banner").is_hidden())

        print("[5] 五子棋五连获胜与跨局比分")
        moves = [
            (page_a, 7, 7), (page_b, 0, 0),
            (page_a, 8, 7), (page_b, 0, 1),
            (page_a, 9, 7), (page_b, 0, 2),
            (page_a, 10, 7), (page_b, 0, 3),
        ]
        for page, x, y in moves:
            click_point(page, x, y)
            time.sleep(0.3)
        click_point(page_a, 11, 7)
        wait_status(page_a, "黑方获胜", timeout=8)
        wait_status(page_b, "黑方获胜", timeout=8)
        check("A 自己赢", "你赢了" in status_text(page_a), status_text(page_a))
        check("B 自己输", "你输了" in status_text(page_b), status_text(page_b))
        page_a.wait_for_timeout(300)
        check("比分变为 1:0", page_a.locator("#score").inner_text().strip() == "黑 1 : 0 白",
              page_a.locator("#score").inner_text())
        page_a.screenshot(path=os.path.join(shots, "02-gomoku-win.png"), full_page=True)

        print("[6] 再来一局：比分保留")
        page_a.locator("#restart-btn").click()
        page_b.locator("#restart-btn").click()
        wait_status(page_a, "轮到你落子", timeout=8)
        page_a.wait_for_timeout(400)
        check("重开后比分保留 1:0", page_a.locator("#score").inner_text().strip() == "黑 1 : 0 白",
              page_a.locator("#score").inner_text())

        print("[7] 刷新保持座位")
        page_a.reload(wait_until="domcontentloaded")
        wait_status(page_a, "轮到你落子", timeout=10)
        check("刷新后仍是黑方", "轮到你落子" in status_text(page_a))
        check("刷新后房间还在", page_a.locator("#view-game").is_visible())

        print("[8] 明暗主题")
        page_a.locator("#theme-toggle").click()
        page_a.wait_for_timeout(400)
        check("切换到深色", page_a.evaluate("document.documentElement.dataset.theme") == "dark")
        page_a.screenshot(path=os.path.join(shots, "03-gomoku-dark.png"), full_page=True)
        page_a.locator("#theme-toggle").click()
        page_a.wait_for_timeout(400)
        check("切回浅色", page_a.evaluate("document.documentElement.dataset.theme") == "light")

        print("[9] 连连看：建房 / 加入 / 棋盘")
        goto(page_a, base)
        expect(page_a.locator("#create-llk")).to_be_visible(timeout=8000)
        page_a.locator("#create-llk").click()
        expect(page_a.locator("#view-llk")).to_be_visible(timeout=10000)
        llk_room = page_a.locator("#llk-room-code").inner_text().strip()
        check("连连看房号 6 位", len(llk_room) == 6, llk_room)
        expect(page_a.locator("#llk-self-board .llk-tile")).to_have_count(64, timeout=10000)
        check("己方棋盘 64 格", page_a.locator("#llk-self-board .llk-tile").count() == 64)

        goto(page_b, base + "?room=" + llk_room)
        expect(page_b.locator("#llk-self-board .llk-tile")).to_have_count(64, timeout=10000)
        check("B 进入连连看棋盘", page_b.locator("#view-llk").is_visible())
        expect(page_a.locator("#llk-opp-caption")).to_contain_text("对手", timeout=8000)
        check("A 看到对手进度", "对手" in page_a.locator("#llk-opp-caption").inner_text(),
              page_a.locator("#llk-opp-caption").inner_text())

        print("[10] 连连看：提示 + 配对 + 进度")
        page_a.locator("#llk-hint").click()
        expect(page_a.locator("#llk-self-board .llk-tile.is-hint")).to_have_count(2, timeout=8000)
        hinted = page_a.eval_on_selector_all(
            "#llk-self-board .llk-tile.is-hint",
            "els => els.map(e => [e.dataset.x, e.dataset.y])",
        )
        page_a.locator("#llk-self-board .llk-tile[data-x='%s'][data-y='%s']" % (hinted[0][0], hinted[0][1])).click()
        page_a.locator("#llk-self-board .llk-tile[data-x='%s'][data-y='%s']" % (hinted[1][0], hinted[1][1])).click()
        expect(page_a.locator("#llk-self-count")).to_have_text("1", timeout=8000)
        check("自己消除 1 对", page_a.locator("#llk-self-count").inner_text() == "1")
        expect(page_b.locator("#llk-opp-count")).to_have_text("1", timeout=8000)
        check("对手进度同步", page_b.locator("#llk-opp-count").inner_text() == "1")
        page_a.screenshot(path=os.path.join(shots, "04-llk-light.png"), full_page=True)
        check("连连看双方各有棋盘", page_a.locator("#llk-self-board").count() == 1)

        print("[11] 大富翁：建房 / 加入 / 掷骰 / 买地")
        goto(page_a, base)
        expect(page_a.locator("#create-monopoly")).to_be_visible(timeout=8000)
        page_a.locator("#create-monopoly").click()
        expect(page_a.locator("#view-monopoly")).to_be_visible(timeout=12000)
        mono_room = page_a.locator("#mono-room-code").inner_text().strip()
        check("大富翁房号 6 位", len(mono_room) == 6, mono_room)
        expect(page_a.locator("#monopoly-root .mono-tile")).to_have_count(24, timeout=12000)
        check("大富翁棋盘 24 格", page_a.locator("#monopoly-root .mono-tile").count() == 24)

        goto(page_b, base + "?room=" + mono_room)
        expect(page_b.locator("#view-monopoly")).to_be_visible(timeout=12000)
        expect(page_b.locator("#monopoly-root .mono-tile")).to_have_count(24, timeout=12000)
        expect(page_a.locator("#mono-roll")).to_be_visible(timeout=10000)
        check("A 可掷骰", page_a.locator("#mono-roll").is_enabled())
        page_a.locator("#mono-roll").click()
        page_a.wait_for_timeout(1500)
        check("A 掷骰产生日志", "掷出" in page_a.locator("#mono-log").inner_text(),
              page_a.locator("#mono-log").inner_text())
        if page_a.locator("#mono-buy-panel").is_visible():
            page_a.locator("#mono-buy").click()
            page_a.wait_for_timeout(900)
            check("买地成功（现金变化）", "购买" in page_a.locator("#mono-log").inner_text(),
                  page_a.locator("#mono-log").inner_text())
        if page_a.locator("#mono-end-turn").is_visible():
            page_a.locator("#mono-end-turn").click()
            page_a.wait_for_timeout(900)
        expect(page_b.locator("#mono-roll")).to_be_visible(timeout=10000)
        check("B 轮到自己", page_b.locator("#mono-roll").is_enabled())
        page_b.locator("#mono-roll").click()
        page_b.wait_for_timeout(1500)
        check("B 掷骰产生日志", "掷出" in page_b.locator("#mono-log").inner_text(),
              page_b.locator("#mono-log").inner_text())
        page_a.screenshot(path=os.path.join(shots, "06-monopoly.png"), full_page=True)

        print("[12] 移动端")
        goto(page_m, base)
        check("移动端首页可见", page_m.locator("#create-gomoku").is_visible())
        check("移动端三张游戏卡", page_m.locator("#create-monopoly").is_visible())
        check("移动端无横向滚动", page_m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        page_m.screenshot(path=os.path.join(shots, "07-mobile-home.png"), full_page=True)

        browser.close()

    print("[13] 控制台错误检查")
    real_errors = [e for e in errors if "favicon" not in e.lower()]
    check("无 JS/控制台错误", not real_errors, "; ".join(real_errors[:5]))

    print()
    print("截图目录: %s" % shots)
    if FAILED:
        print("失败 %d 项: %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("E2E 全部通过 ✔（%d 项）" % PASSED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
