from __future__ import annotations

import shutil
import tempfile
import threading
import uuid
from pathlib import Path

from werkzeug.datastructures import FileStorage

from .models import StoredPackage
from .parser import parse_package


class PackageStore:
    def __init__(self) -> None:
        self._base_dir = Path(tempfile.gettempdir(), "unitypackage-browser-web")
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._sessions: dict[str, StoredPackage] = {}

    def save_upload(self, upload: FileStorage) -> StoredPackage:
        session_id = uuid.uuid4().hex
        package_dir = self._base_dir / session_id
        package_dir.mkdir(parents=True, exist_ok=True)

        safe_name = Path(upload.filename or "package.unitypackage").name
        package_path = package_dir / safe_name
        upload.save(package_path)

        parsed_package = StoredPackage(
            session_id=session_id,
            package_name=safe_name,
            package_path=str(package_path),
            assets=parse_package(str(package_path)),
        )

        with self._lock:
            self._sessions[session_id] = parsed_package

        return parsed_package

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
