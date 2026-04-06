from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_IDENTITY_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ1vTxn8EW89yA6cK2n3jCFxc8YUb39Nw9W1fKctHr_21oHzySw3_FGmCsagdr3mCUGC35xY_czo40G/pub?output=csv"


def _parse_bool_env(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default

    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def _read_theme_mode() -> str:
    theme_mode = os.getenv("UNITYPACKAGE_BROWSER_THEME", "dark").strip().lower()
    if theme_mode not in {"dark", "light"}:
        return "dark"
    return theme_mode


@dataclass(slots=True)
class AppSettings:
    frontend_dist: str | None
    theme: str
    theme_enforced: bool
    identity_catalog_url: str
    identity_lookup_enabled: bool
    identity_lookup_timeout_seconds: float
    allowed_origin: str

    @property
    def static_folder(self) -> str | None:
        if not self.frontend_dist:
            return None

        dist_path = Path(self.frontend_dist)
        if dist_path.exists():
            return str(dist_path)
        return None


def load_settings() -> AppSettings:
    identity_catalog_url = os.getenv("UNITYPACKAGE_BROWSER_IDENTITY_CSV_URL", DEFAULT_IDENTITY_CSV_URL).strip()
    return AppSettings(
        frontend_dist=os.getenv("FRONTEND_DIST"),
        theme=_read_theme_mode(),
        theme_enforced=_parse_bool_env("UNITYPACKAGE_BROWSER_ENFORCE_THEME", True),
        identity_catalog_url=identity_catalog_url,
        identity_lookup_enabled=bool(identity_catalog_url),
        identity_lookup_timeout_seconds=float(os.getenv("UNITYPACKAGE_BROWSER_IDENTITY_TIMEOUT_SECONDS", "5")),
        allowed_origin=os.getenv("FRONTEND_ORIGIN", "*"),
    )