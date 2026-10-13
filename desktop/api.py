"""
API-мост между JavaScript и Python.
Из JS вызывается через window.pywebview.api.<method>()
"""
import os
import sys
import platform
import subprocess
from datetime import datetime
import webview


class DesktopAPI:
    def __init__(self, window=None):
        self.window = window

    # ---------- Окно ----------
    def minimize(self):
        self.window.minimize()
        return {"ok": True}

    def maximize(self):
        self.window.toggle_fullscreen()
        return {"ok": True}

    def close(self):
        self.window.destroy()
        return {"ok": True}

    # ---------- Система ----------
    def get_system_info(self):
        return {
            "platform": platform.system(),
            "platform_release": platform.release(),
            "python_version": sys.version,
            "app_version": "1.0.0",
            "mode": "desktop"
        }

    # ---------- Файлы ----------
    def save_recording(self, filename=None):
        if not filename:
            filename = f"sink-recording-{datetime.now():%Y%m%d-%H%M%S}.webm"
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=os.path.expanduser("~/Videos"),
            save_filename=filename,
            file_types=("Video (*.webm;*.mp4)", "All (*.*)")
        )
        return {"path": result[0] if result else None}

    def save_whiteboard(self):
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=os.path.expanduser("~/Pictures"),
            save_filename=f"whiteboard-{datetime.now():%Y%m%d-%H%M%S}.png",
            file_types=("PNG (*.png)", "All (*.*)")
        )
        return {"path": result[0] if result else None}

    def _save_binary(self, path: str, data):
        try:
            if isinstance(data, str):
                data = data.encode("latin-1")
            with open(path, "wb") as f:
                f.write(data)
            return {"ok": True, "path": path}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def open_file(self, path: str):
        try:
            if platform.system() == "Windows":
                os.startfile(path)
            elif platform.system() == "Darwin":
                subprocess.run(["open", path])
            else:
                subprocess.run(["xdg-open", path])
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------- Буфер ----------
    def copy_to_clipboard(self, text: str):
        try:
            import tkinter
            r = tkinter.Tk()
            r.withdraw()
            r.clipboard_clear()
            r.clipboard_append(text)
            r.update()
            r.destroy()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------- Уведомления ----------
    def notify(self, title: str, message: str):
        try:
            if platform.system() == "Windows":
                try:
                    from win10toast import ToastNotifier
                    ToastNotifier().show_toast(title, message, duration=5, threaded=True)
                except ImportError:
                    pass
            elif platform.system() == "Darwin":
                subprocess.run([
                    "osascript", "-e",
                    f'display notification "{message}" with title "{title}"'
                ])
            else:
                subprocess.run(["notify-send", title, message])
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}