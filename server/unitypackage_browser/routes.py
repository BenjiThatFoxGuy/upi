from __future__ import annotations

import io
import mimetypes
import tarfile
from pathlib import PurePosixPath

from flask import Blueprint, abort, jsonify, request, send_file

from .models import ParsedAsset, StoredPackage
from .store import package_store


api = Blueprint("api", __name__)


def _serialize_asset(asset: ParsedAsset) -> dict[str, object]:
    return {
        "assetId": asset.asset_id,
        "guid": asset.guid,
        "pathname": asset.pathname,
        "size": asset.size,
        "hasMeta": asset.has_meta,
        "safePath": asset.safe_path,
    }


def _serialize_package(package: StoredPackage) -> dict[str, object]:
    return {
        "sessionId": package.session_id,
        "packageName": package.package_name,
        "assetCount": len(package.assets),
        "assets": [_serialize_asset(asset) for asset in package.assets],
    }


@api.get("/health")
def api_health() -> tuple[dict[str, str], int]:
    return {"status": "ok"}, 200


@api.post("/package/index")
def package_index():
    upload = request.files.get("package")
    if upload is None or upload.filename is None:
        return jsonify({"error": "Expected a multipart file field named 'package'."}), 400

    if not upload.filename.lower().endswith(".unitypackage"):
        return jsonify({"error": "Only .unitypackage files are supported."}), 400

    stored = package_store.save_upload(upload)
    return jsonify(_serialize_package(stored))


@api.get("/package/<session_id>/assets/<path:asset_id>/download")
def download_asset(session_id: str, asset_id: str):
    package = package_store.get(session_id)
    if package is None:
        abort(404, description="Package session not found.")

    selected = next((asset for asset in package.assets if asset.asset_id == asset_id), None)
    if selected is None:
        abort(404, description="Asset not found.")

    with tarfile.open(package.package_path, mode="r:gz") as archive:
        extracted = archive.extractfile(selected.tar_member_name)
        if extracted is None:
            abort(404, description="Asset payload could not be read.")

        filename = PurePosixPath(selected.pathname).name or f"{selected.guid}.bin"
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return send_file(
            io.BytesIO(extracted.read()),
            mimetype=mime_type,
            as_attachment=True,
            download_name=filename,
            max_age=0,
        )


@api.delete("/package/<session_id>")
def delete_package(session_id: str):
    if package_store.get(session_id) is None:
        abort(404, description="Package session not found.")

    package_store.cleanup(session_id)
    return "", 204
