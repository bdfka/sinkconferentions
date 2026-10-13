"""
SinkConferentions Desktop
Запуск: python main.py
"""
import os
import sys
import platform
import webview
from config import Config
from api import DesktopAPI


class SinkApp:
    def __init__(self):
        self.window = None
        self.api = DesktopAPI()

    def on_loaded(self):
        self.window.evaluate_js("""
            window.SinkDesktop = {
                isDesktop: true,
                platform: 'desktop',
                minimize: () => pywebview.api.minimize(),
                maximize: () => pywebview.api.maximize(),
                close:    () => pywebview.api.close(),
                getSystemInfo: () => pywebview.api.get_system_info(),
                saveRecording: (name) => pywebview.api.save_recording(name),
                saveWhiteboard: () => pywebview.api.save_whiteboard(),
                openFile: (path) => pywebview.api.open_file(path),
                copy: (text) => pywebview.api.copy_to_clipboard(text),
                notify: (title, msg) => pywebview.api.notify(title, msg),
            };
            document.documentElement.classList.add('desktop-app');
            console.log('[SinkDesktop] API injected');
        """)

    def run(self):
        url = Config.get_url()

        self.window = webview.create_window(
            title=Config.WINDOW_TITLE,
            url=url,
            width=Config.WINDOW_WIDTH,
            height=Config.WINDOW_HEIGHT,
            min_size=(Config.WINDOW_MIN_WIDTH, Config.WINDOW_MIN_HEIGHT),
            resizable=True,
            text_select=True,
            js_api=self.api,
        )
        self.api.window = self.window

        self.window.events.loaded += self.on_loaded

        webview.start(
            debug=os.getenv("DEBUG", "0") == "1",
            storage_path=Config.STORAGE_PATH,
            private_mode=False,
        )


def check_dependencies():
    if platform.system() == "Linux":
        try:
            import gi
            gi.require_version("WebKit2", "4.1")
        except (ImportError, ValueError):
            print("⚠️  Установите WebKitGTK:")
            print("    Ubuntu: sudo apt install python3-gi gir1.2-webkit2-4.1")
            print("    Arch:   sudo pacman -S webkit2gtk-4.1")
            sys.exit(1)


if __name__ == "__main__":
    check_dependencies()
    print(f"🚀 Запуск SinkConferentions Desktop → {Config.get_url()}")
    SinkApp().run()