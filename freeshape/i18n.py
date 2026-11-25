"""Optional UI translations, with safe English fallbacks."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path


def _short_language(value):
    return str(value or "en").split(".")[0].replace("-", "_").split("_")[0].lower()


def current_language():
    """Use FREESHAPE_LANG, a stored preference, or the desktop's language."""
    override = os.environ.get("FREESHAPE_LANG", "").strip()
    if override:
        return _short_language(override)
    try:
        from PySide6.QtCore import QSettings, QLocale
        preference = str(QSettings("FreeShape", "FreeShape").value("language", "system"))
        if preference and preference != "system":
            return _short_language(preference)
        return _short_language(QLocale.system().name())
    except ImportError:
        return _short_language(os.environ.get("LANG", "en"))


@lru_cache(maxsize=8)
def _catalog(language):
    path = Path(__file__).resolve().parent / "locale" / (language + ".json")
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return {str(key): str(value) for key, value in data.items() if value}


def tr(source):
    """Translate a UI label; strings not in the catalog remain English."""
    language = current_language()
    if language == "en":
        return source
    return _catalog(language).get(source, source)
