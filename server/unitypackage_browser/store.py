from __future__ import annotations

import re
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import urlopen

from werkzeug.datastructures import FileStorage

from .identity import build_package_fingerprint, identify_package
from .models import StoredPackage
from .parser import parse_package


class PackageStore:
    def __init__(self) -> None:
        self._base_dir = Path(tempfile.gettempdir(), "unitypackage-browser-web")
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._sessions: dict[str, StoredPackage] = {}

    def _create_session_dir(self) -> tuple[str, Path]:
        session_id = uuid.uuid4().hex
        package_dir = self._base_dir / session_id
        package_dir.mkdir(parents=True, exist_ok=True)
        return session_id, package_dir

    def save_upload(self, upload: FileStorage) -> StoredPackage:
        session_id, package_dir = self._create_session_dir()

        safe_name = Path(upload.filename or "package.unitypackage").name
        package_path = package_dir / safe_name
        upload.save(package_path)

        return self._store_package(session_id, package_path, safe_name)

    def save_remote_url(self, package_url: str) -> StoredPackage:
        session_id, package_dir = self._create_session_dir()

        parsed_url = urlparse(package_url)
        if parsed_url.scheme not in {"http", "https"}:
            raise ValueError("Only http and https package URLs are supported.")

        fallback_name = Path(parsed_url.path).name or "package.unitypackage"
        safe_name = self._normalize_package_name(fallback_name)
        resolved_name = safe_name
        package_path = package_dir / safe_name

        with urlopen(package_url, timeout=60) as response:
            header_name = self._filename_from_content_disposition(response.headers.get("Content-Disposition"))
            if header_name:
                resolved_name = self._normalize_package_name(header_name)
                package_path = package_dir / resolved_name

            with package_path.open("wb") as output_file:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output_file.write(chunk)

        return self._store_package(session_id, package_path, resolved_name)

    def save_local_path(self, package_path: str, package_name: str | None = None) -> StoredPackage:
        source_path = Path(package_path)
        if not source_path.exists() or not source_path.is_file():
            raise ValueError("Expected an existing package file path.")

        session_id, package_dir = self._create_session_dir()
        resolved_name = self._normalize_package_name(package_name or source_path.name)
        stored_path = package_dir / resolved_name
        shutil.copy2(source_path, stored_path)
        return self._store_package(session_id, stored_path, resolved_name)

    def _store_package(self, session_id: str, package_path: Path, package_name: str) -> StoredPackage:
        assets = parse_package(str(package_path))
        fingerprint = build_package_fingerprint(str(package_path), assets)
        identity = identify_package(package_name, fingerprint, assets)

        parsed_package = StoredPackage(
            session_id=session_id,
            package_name=package_name,
            package_path=str(package_path),
            assets=assets,
            fingerprint=fingerprint,
            identity=identity,
        )

        with self._lock:
            self._sessions[session_id] = parsed_package

        return parsed_package

    @staticmethod
    def _normalize_package_name(filename: str) -> str:
        safe_name = Path(filename or "package.unitypackage").name
        if not safe_name.lower().endswith(".unitypackage"):
            safe_name = f"{safe_name}.unitypackage"
        return safe_name

    @staticmethod
    def _filename_from_content_disposition(content_disposition: str | None) -> str | None:
        if not content_disposition:
            return None

        utf_match = re.search(r"filename\*=UTF-8''([^;]+)", content_disposition, re.IGNORECASE)
        if utf_match:
            return unquote(utf_match.group(1))

        ascii_match = re.search(r'filename="?([^";]+)"?', content_disposition, re.IGNORECASE)
        if ascii_match:
            return ascii_match.group(1)

        return None

    def get(self, session_id: str) -> StoredPackage | None:
        with self._lock:
            return self._sessions.get(session_id)

    def cleanup(self, session_id: str) -> None:
        with self._lock:
            package = self._sessions.pop(session_id, None)
        if package is None:
            return

        shutil.rmtree(Path(package.package_path).parent, ignore_errors=True)


package_store = PackageStore()
