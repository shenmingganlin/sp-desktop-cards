# icons.py — 用 Edge 无头模式把 assets/icon.svg 渲染成 PNG。
# 输出：icon.png（256，打包和窗口图标）、tray.png（16）、tray@2x.png（32，高分屏托盘）。
# 用法：python scripts/icons.py
import pathlib
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent / "assets"
svg = (root / "icon.svg").read_text(encoding="utf-8")

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page()
    for name, size in [("icon.png", 256), ("tray.png", 16), ("tray@2x.png", 32)]:
        page.set_viewport_size({"width": size, "height": size})
        page.set_content(
            f'<html><body style="margin:0;background:transparent">'
            f'<div style="width:{size}px;height:{size}px">{svg.replace("<svg ", f"<svg width={size} height={size} ", 1)}</div>'
            f"</body></html>"
        )
        page.locator("div").screenshot(path=str(root / name), omit_background=True)
        print(name, size)
    browser.close()
