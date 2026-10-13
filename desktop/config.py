import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    APP_URL = os.getenv("APP_URL", "https://sinkconferentions.onrender.com")
    LOCAL_URL = os.getenv("LOCAL_URL", "http://localhost:3001")
    MODE = os.getenv("MODE", "remote")

    WINDOW_TITLE = "SinkConferentions"
    WINDOW_WIDTH = 1400
    WINDOW_HEIGHT = 900
    WINDOW_MIN_WIDTH = 900
    WINDOW_MIN_HEIGHT = 600

    STORAGE_PATH = os.path.join(os.path.expanduser("~"), ".sinkconferentions")

    @classmethod
    def get_url(cls) -> str:
        return cls.LOCAL_URL if cls.MODE == "local" else cls.APP_URL


os.makedirs(Config.STORAGE_PATH, exist_ok=True)