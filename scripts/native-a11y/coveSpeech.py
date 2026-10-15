"""Capture actual NVDA speech output in an isolated CI profile; never alter it."""
import json
import os
import time
import globalPluginHandler
import versionInfo
from speech import extensions


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = os.environ["COVE_NVDA_SPEECH_LOG"]
        extensions.pre_speech.register(self.capture)
        self.write({"ready": True, "version": versionInfo.version})

    def write(self, value):
        with open(self.path, "a", encoding="utf-8") as output:
            output.write(json.dumps({"at": time.time(), **value}, ensure_ascii=False) + "\n")

    def capture(self, speechSequence, **kwargs):
        text = " ".join(part for part in speechSequence if isinstance(part, str))
        if text.strip():
            self.write({"text": text})

    def terminate(self):
        extensions.pre_speech.unregister(self.capture)
        super().terminate()
