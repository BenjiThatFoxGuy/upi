from __future__ import annotations

from .models import PackageIdentity, PackageSourceLink, ParsedAsset, StoredPackage


def serialize_asset(asset: ParsedAsset) -> dict[str, object]:
    return {
        "assetId": asset.asset_id,
        "guid": asset.guid,
        "pathname": asset.pathname,
        "size": asset.size,
        "hasMeta": asset.has_meta,
        "safePath": asset.safe_path,
    }


def serialize_source_link(source_link: PackageSourceLink) -> dict[str, str]:
    return {
        "label": source_link.label,
        "url": source_link.url,
    }


def serialize_identity(identity: PackageIdentity) -> dict[str, object]:
    return {
        "lookupStatus": identity.lookup_status,
        "recognitionStatus": identity.recognition_status,
        "matchType": identity.match_type,
        "displayName": identity.display_name,
        "baseName": identity.base_name,
        "version": identity.version,
        "author": identity.author,
        "thumbnailUrl": identity.thumbnail_url,
        "sourceLinks": [serialize_source_link(source_link) for source_link in identity.source_links],
        "message": identity.message,
    }


def serialize_package(package: StoredPackage) -> dict[str, object]:
    return {
        "sessionId": package.session_id,
        "packageName": package.package_name,
        "assetCount": len(package.assets),
        "fingerprint": {
            "md5": package.fingerprint.md5,
            "sha256": package.fingerprint.sha256,
            "guidFingerprint": package.fingerprint.guid_fingerprint,
            "guidCount": package.fingerprint.guid_count,
            "guidValues": package.fingerprint.guid_values,
            "guidSample": package.fingerprint.guid_sample,
            "assetCount": package.fingerprint.asset_count,
            "safeAssetCount": package.fingerprint.safe_asset_count,
            "unsafeAssetCount": package.fingerprint.unsafe_asset_count,
        },
        "identity": serialize_identity(package.identity),
        "assets": [serialize_asset(asset) for asset in package.assets],
    }


def error_payload(message: str) -> dict[str, str]:
    return {"error": message}