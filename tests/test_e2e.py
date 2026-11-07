#!/usr/bin/env python3
"""五子棋浏览器端到端测试（Playwright + 本机 Edge）。

前置：
    1. 启动服务：python server.py --port 8086
    2. 安装 playwright 的 Python 包（已具备）；使用系统 Edge（channel="msedge"）无需下载浏览器

运行：python tests/test_e2e.py [--port 8086]

覆盖：建房、邀请链接加入、观战、画布点击落子、五连判胜、双方再来一局、刷新重连保座、
      明暗主题切换、控制台无报错，并输出截图。
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8086)
    parser.add_argument("--base", default="", help="完整服务地址（如 https://wkeeli.cn/gomoku/），优先于 --port")
    args = parser.parse_args()
    base = args.base
    if not base:
        base = "http://127.0.0.1:%d/" % args.port
    base = base.rstrip("/") + "/"
    shots = os.path.join(tempfile.gettempdir(), "gomoku-e2e")
    os.makedirs(shots, exist_ok=True)

    errors = []

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

        print("[1] A 创建房间")
        page_a.goto(base, wait_until="networkidle")
        check("大厅标题", page_a.locator("h1").inner_text() == "五子棋")
        page_a.locator("#create-btn").click()
        expect(page_a.locator("#view-game")).to_be_visible(timeout=8000)
        room = page_a.locator("#room-code").inner_text().strip()
        check("房号 6 位", len(room) == 6, room)
        check("URL 带房间参数", ("room=" + room) in page_a.url, page_a.url)
        wait_status(page_a, "等待对手加入房间")
        check("A 等待对手", "等待对手加入房间" in status_text(page_a))

        print("[2] B 通过邀请链接加入")
        page_b.goto(base + "?room=" + room, wait_until="networkidle")
        wait_status(page_b, "等待对手落子")
        wait_status(page_a, "轮到你落子")
        check("B 执白等待", "等待对手落子" in status_text(page_b))
        check("A 轮到自己", "轮到你落子" in status_text(page_a))

        print("[3] C 观战")
        page_c.goto(base + "?room=" + room, wait_until="networkidle")
        wait_status(page_c, "观战中")
        check("C 观战状态", "观战中" in status_text(page_c))
        check("A 看到观战人数", "观战 1 人" in page_a.locator("#presence").inner_text(),
              page_a.locator("#presence").inner_text())

        print("[4] 画布点击对弈（黑方横向五连）")
        moves = [
            (page_a, 7, 7), (page_b, 0, 0),
            (page_a, 8, 7), (page_b, 0, 1),
            (page_a, 9, 7), (page_b, 0, 2),
            (page_a, 10, 7), (page_b, 0, 3),
        ]
        for page, x, y in moves:
            click_point(page, x, y)
            time.sleep(0.35)
        click_point(page_a, 11, 7)
        wait_status(page_a, "黑方获胜", timeout=8)
        wait_status(page_b, "黑方获胜", timeout=8)
        check("A 判定黑胜（自己赢）", "你赢了" in status_text(page_a), status_text(page_a))
        check("B 判定黑胜（自己输）", "你输了" in status_text(page_b), status_text(page_b))
        check("观战者同步结果", "观战" in status_text(page_c), status_text(page_c))
        page_a.screenshot(path=os.path.join(shots, "01-win-light.png"), full_page=True)

        print("[5] 双方再来一局")
        page_a.locator("#restart-btn").click()
        wait_status(page_a, "你已准备再来一局", timeout=5)
        page_b.locator("#restart-btn").click()
        wait_status(page_a, "轮到你落子", timeout=8)
        wait_status(page_b, "等待对手落子", timeout=8)
        check("重开后轮到黑方", "轮到你落子" in status_text(page_a))
        check("重开后白方等待", "等待对手落子" in status_text(page_b))
        check("重开后按钮恢复", page_a.locator("#restart-btn").is_visible())

        print("[6] 刷新保持座位")
        page_a.reload(wait_until="networkidle")
        wait_status(page_a, "轮到你落子", timeout=8)
        check("刷新后仍是黑方", "轮到你落子" in status_text(page_a), status_text(page_a))
        check("刷新后 B 未掉线", "等待对手落子" in status_text(page_b), status_text(page_b))

        print("[7] 明暗主题切换")
        page_a.locator("#theme-toggle").click()
        page_a.wait_for_timeout(400)
        theme_dark = page_a.evaluate("document.documentElement.dataset.theme")
        check("切换到深色", theme_dark == "dark", str(theme_dark))
        page_a.screenshot(path=os.path.join(shots, "02-game-dark.png"), full_page=True)
        page_a.locator("#theme-toggle").click()
        page_a.wait_for_timeout(400)
        theme_light = page_a.evaluate("document.documentElement.dataset.theme")
        check("切回浅色", theme_light == "light", str(theme_light))

        print("[8] 移动端适配")
        page_m.goto(base, wait_until="networkidle")
        check("移动端大厅可见", page_m.locator("#create-btn").is_visible())
        page_m.screenshot(path=os.path.join(shots, "03-mobile-light.png"), full_page=True)
        check("无横向滚动", page_m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))

        browser.close()

    print("[9] 控制台错误检查")
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
