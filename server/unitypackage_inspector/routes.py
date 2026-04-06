from __future__ import annotations

import io
import mimetypes

from flask import Blueprint, abort, current_app, jsonify, request, send_file

from .serializers import error_payload, serialize_identity, serialize_package
from .services import package_api_service


api = Blueprint("api", __name__)


def _package_or_404(session_id: str):
    package = package_api_service.get_package(session_id)
    if package is None:
        abort(404, description="Package session not found.")
    return package


@api.get("/health")
def api_health() -> tuple[dict[str, str], int]:
    return {"status": "ok"}, 200


@api.get("/config")
def api_config() -> tuple[dict[str, object], int]:
    return {
        "theme": current_app.config.get("UI_THEME", "dark"),
        "themeEnforced": bool(current_app.config.get("UI_THEME_ENFORCED", True)),
        "identityLookupEnabled": bool(current_app.config.get("IDENTITY_LOOKUP_ENABLED", False)),
        "identityCatalogUrl": current_app.config.get("IDENTITY_CATALOG_URL", ""),
    }, 200


@api.post("/package/identify")
def package_identify():
    return _identity_lookup_response()


@api.post("/identity/lookup")
def identity_lookup():
    return _identity_lookup_response()


def _identity_lookup_response():
    payload = request.get_json(silent=True) or {}
    try:
        identity = package_api_service.identify_fingerprint(payload)
    except (TypeError, ValueError):
        return jsonify(error_payload("Expected a valid package fingerprint payload.")), 400

    return jsonify(serialize_identity(identity))


@api.get("/identity/thumbnail")
def identity_thumbnail_proxy():
    thumbnail_url = request.args.get("url", "").strip()
    if not thumbnail_url:
        return jsonify(error_payload("Expected a non-empty 'url' query parameter.")), 400

    timeout_seconds = float(current_app.config.get("IDENTITY_LOOKUP_TIMEOUT_SECONDS", 5.0))
    try:
        payload, content_type = package_api_service.proxy_thumbnail(thumbnail_url, timeout_seconds)
    except ValueError as error:
        return jsonify(error_payload(str(error))), 400
    except Exception:
        return jsonify(error_payload("Failed to fetch thumbnail.")), 502

    mimetype = content_type or mimetypes.guess_type(thumbnail_url)[0] or "application/octet-stream"
    return send_file(io.BytesIO(payload), mimetype=mimetype, max_age=300)


@api.post("/package/index")
def package_index():
    return _index_upload_response()


@api.post("/packages/index")
def packages_index():
    return _index_upload_response()


def _index_upload_response():
    upload = request.files.get("package")
    if upload is None or upload.filename is None:
        return jsonify(error_payload("Expected a multipart file field named 'package'.")), 400

    if not upload.filename.lower().endswith(".unitypackage"):
        return jsonify(error_payload("Only .unitypackage files are supported.")), 400

    stored = package_api_service.index_upload(upload)
    return jsonify(serialize_package(stored))


@api.post("/package/index-url")
def package_index_url():
    return _index_url_response()


@api.post("/packages/index-url")
def packages_index_url():
    return _index_url_response()


def _index_url_response():
    payload = request.get_json(silent=True) or {}
    package_url = payload.get("url")
    if not isinstance(package_url, str) or not package_url.strip():
        return jsonify(error_payload("Expected a JSON body with a non-empty 'url' field.")), 400

    try:
        stored = package_api_service.index_url(package_url.strip())
    except ValueError as error:
        return jsonify(error_payload(str(error))), 400
    except Exception:
        return jsonify(error_payload("Failed to fetch or index the remote unitypackage URL.")), 502

    return jsonify(serialize_package(stored))


@api.get("/packages/<session_id>")
def get_package_manifest(session_id: str):
    package = _package_or_404(session_id)
    return jsonify(serialize_package(package))


@api.get("/package/<session_id>/assets/<path:asset_id>/download")
def download_asset(session_id: str, asset_id: str):
    return _download_asset_response(session_id, asset_id)


@api.get("/packages/<session_id>/assets/<path:asset_id>/download")
def download_asset_v2(session_id: str, asset_id: str):
    return _download_asset_response(session_id, asset_id)


def _download_asset_response(session_id: str, asset_id: str):
    package = _package_or_404(session_id)
    try:
        payload, filename, mime_type = package_api_service.download_asset_bytes(package, asset_id)
    except LookupError:
        abort(404, description="Asset not found.")
    except FileNotFoundError:
        abort(404, description="Asset payload could not be read.")

    return send_file(
        io.BytesIO(payload),
        mimetype=mime_type,
        as_attachment=True,
        download_name=filename,
        max_age=0,
    )


@api.get("/package/<session_id>/download.zip")
def download_package_zip(session_id: str):
    return _download_package_zip_response(session_id)


@api.get("/packages/<session_id>/download.zip")
def download_package_zip_v2(session_id: str):
    return _download_package_zip_response(session_id)


def _download_package_zip_response(session_id: str):
    package = _package_or_404(session_id)
    archive_bytes, download_name = package_api_service.build_package_zip(package)
    return send_file(
        archive_bytes,
        mimetype="application/zip",
        as_attachment=True,
        download_name=download_name,
        max_age=0,
    )


@api.delete("/package/<session_id>")
def delete_package(session_id: str):
    return _delete_package_response(session_id)


@api.delete("/packages/<session_id>")
def delete_package_v2(session_id: str):
    return _delete_package_response(session_id)


def _delete_package_response(session_id: str):
    _package_or_404(session_id)
    package_api_service.delete_package(session_id)
    return "", 204
