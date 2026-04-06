from __future__ import annotations

import io
import mimetypes
import tarfile
import zipfile
from pathlib import PurePosixPath

from werkzeug.datastructures import FileStorage

from .identity import fetch_remote_thumbnail_bytes, identify_fingerprint_payload
from .models import ParsedAsset, StoredPackage
from .store import package_store


def safe_zip_segment(segment: str) -> str:
    sanitized = "".join("_" if character in '<>:"|?*' else character for character in segment).strip()
    return sanitized or "unnamed"


def zip_entry_path(asset: ParsedAsset, include_meta: bool = False) -> str:
    normalized_parts = [safe_zip_segment(part) for part in asset.pathname.replace("\\", "/").split("/") if part]
    if asset.safe_path and normalized_parts:
        path = "/".join(normalized_parts)
    else:
        fallback = safe_zip_segment(PurePosixPath(asset.pathname).name or f"{asset.guid}.bin")
        path = f"_flagged/{safe_zip_segment(asset.guid)}/{fallback}"

    return f"{path}.meta" if include_meta else path


def zip_filename(package_name: str) -> str:
    suffix = ".unitypackage"
    if package_name.lower().endswith(suffix):
        return f"{package_name[:-len(suffix)]}.zip"
    return f"{package_name}.zip"


class PackageApiService:
    def identify_fingerprint(self, payload: dict[str, object]):
        return identify_fingerprint_payload(payload)

    def index_upload(self, upload: FileStorage) -> StoredPackage:
        return package_store.save_upload(upload)

    def index_url(self, package_url: str) -> StoredPackage:
        return package_store.save_remote_url(package_url)

    def get_package(self, session_id: str) -> StoredPackage | None:
        return package_store.get(session_id)

    def delete_package(self, session_id: str) -> None:
        package_store.cleanup(session_id)

    def download_asset_bytes(self, package: StoredPackage, asset_id: str) -> tuple[bytes, str, str]:
        selected = next((asset for asset in package.assets if asset.asset_id == asset_id), None)
        if selected is None:
            raise LookupError("Asset not found.")

        with tarfile.open(package.package_path, mode="r:gz") as archive:
            extracted = archive.extractfile(selected.tar_member_name)
            if extracted is None:
                raise FileNotFoundError("Asset payload could not be read.")

            filename = PurePosixPath(selected.pathname).name or f"{selected.guid}.bin"
            mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            return extracted.read(), filename, mime_type

    def build_package_zip(self, package: StoredPackage) -> tuple[io.BytesIO, str]:
        archive_bytes = io.BytesIO()
        with tarfile.open(package.package_path, mode="r:gz") as source_archive:
            with zipfile.ZipFile(archive_bytes, mode="w", compression=zipfile.ZIP_STORED) as output_archive:
                for asset in package.assets:
                    extracted = source_archive.extractfile(asset.tar_member_name)
                    if extracted is None:
                        continue

                    output_archive.writestr(zip_entry_path(asset), extracted.read())

                    if asset.meta_member_name is None:
                        continue

                    meta_extracted = source_archive.extractfile(asset.meta_member_name)
                    if meta_extracted is None:
                        continue

                    output_archive.writestr(zip_entry_path(asset, include_meta=True), meta_extracted.read())

        archive_bytes.seek(0)
        return archive_bytes, zip_filename(package.package_name)

    def proxy_thumbnail(self, url: str, timeout_seconds: float) -> tuple[bytes, str | None]:
        return fetch_remote_thumbnail_bytes(url, timeout_seconds)


package_api_service = PackageApiService()