from __future__ import annotations

import csv
import hashlib
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen

from .models import PackageFingerprint, PackageIdentity, PackageSourceLink, ParsedAsset


DEFAULT_IDENTITY_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ1vTxn8EW89yA6cK2n3jCFxc8YUb39Nw9W1fKctHr_21oHzySw3_FGmCsagdr3mCUGC35xY_czo40G/pub?output=csv"

_catalog_cache: tuple[float, list[dict[str, str]]] | None = None


def _is_dev_mode() -> bool:
    env_candidates = (
        os.getenv("UPI_DEV", ""),
        os.getenv("FLASK_ENV", ""),
        os.getenv("FLASK_DEBUG", ""),
        os.getenv("PYTHON_ENV", ""),
    )
    normalized = [candidate.strip().lower() for candidate in env_candidates if candidate]
    return any(value in {"1", "true", "yes", "on", "dev", "development"} for value in normalized)


def compute_file_hash(package_path: str, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with Path(package_path).open("rb") as package_file:
        while True:
            chunk = package_file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)

    return digest.hexdigest()


def compute_file_sha256(package_path: str) -> str:
    return compute_file_hash(package_path, "sha256")


def compute_file_md5(package_path: str) -> str:
    return compute_file_hash(package_path, "md5")


def build_package_fingerprint(package_path: str, assets: list[ParsedAsset]) -> PackageFingerprint:
    unique_guids = sorted({asset.guid for asset in assets})
    guid_digest = hashlib.sha256("\n".join(unique_guids).encode("utf-8")).hexdigest()
    safe_asset_count = sum(1 for asset in assets if asset.safe_path)
    unsafe_asset_count = len(assets) - safe_asset_count
    return PackageFingerprint(
        md5=compute_file_md5(package_path),
        sha256=compute_file_sha256(package_path),
        guid_fingerprint=guid_digest,
        guid_count=len(unique_guids),
        guid_values=unique_guids,
        guid_sample=unique_guids[:32],
        asset_count=len(assets),
        safe_asset_count=safe_asset_count,
        unsafe_asset_count=unsafe_asset_count,
    )


def identify_package(package_name: str, fingerprint: PackageFingerprint, assets: list[ParsedAsset] | None = None) -> PackageIdentity:
    if fingerprint.asset_count == 0 or fingerprint.guid_count == 0:
        return PackageIdentity(
            lookup_status="resolved",
            recognition_status="corrupt",
            match_type="none",
            display_name=None,
            base_name=None,
            version=None,
            author=None,
            thumbnail_url=None,
            source_links=[],
            message="No valid Unity assets were found in this package.",
        )

    catalog_url = os.getenv("UPI_IDENTITY_CSV_URL", DEFAULT_IDENTITY_CSV_URL).strip()
    if not catalog_url:
        return PackageIdentity(
            lookup_status="unavailable",
            recognition_status="unknown",
            match_type="none",
            display_name=None,
            base_name=None,
            version=None,
            author=None,
            thumbnail_url=None,
            source_links=[],
            message="Identity lookup is not configured on this server.",
        )

    catalog_rows = load_identity_catalog(catalog_url)
    if catalog_rows is None:
        return PackageIdentity(
            lookup_status="unavailable",
            recognition_status="unknown",
            match_type="none",
            display_name=None,
            base_name=None,
            version=None,
            author=None,
            thumbnail_url=None,
            source_links=[],
            message="Identity catalog could not be loaded from the configured CSV.",
        )

    hash_match = _match_by_hash(catalog_rows, fingerprint)
    if hash_match is not None:
        row, matched_version = hash_match
        return _build_catalog_identity(row, "known-good", "hash", package_name, matched_version=matched_version)

    guid_match = _match_by_guids(catalog_rows, set(fingerprint.guid_values), fingerprint.guid_count)
    if guid_match is not None:
        row, guid_coverage, overlap, matched_version, matched_guids = guid_match
        recognition_status = _determine_guid_match_status(row, guid_coverage, overlap)
        matched_guid_examples = None
        matched_file_examples = None
        if assets and matched_guids:
            guids = []
            pathnames = []
            for asset in assets:
                if asset.guid in matched_guids and len(guids) < 3:
                    guids.append(asset.guid)
                    pathnames.append(asset.pathname)
            if guids:
                matched_guid_examples = guids
                matched_file_examples = pathnames
        return _build_catalog_identity(row, recognition_status, "guids", package_name, guid_coverage=guid_coverage, matched_version=matched_version, matched_guid_examples=matched_guid_examples, matched_file_pathnames=matched_file_examples)

    return PackageIdentity(
        lookup_status="resolved",
        recognition_status="unknown",
        match_type="none",
        display_name=None,
        base_name=None,
        version=None,
        author=None,
        thumbnail_url=None,
        source_links=[],
        message=f"{package_name} did not match any known hash or GUID lineage in the catalog.",
    )


def identify_fingerprint_payload(payload: dict[str, Any]) -> PackageIdentity:
    fingerprint = PackageFingerprint(
        md5=str(payload.get("md5", "")).strip().lower(),
        sha256=str(payload.get("sha256", "")).strip().lower(),
        guid_fingerprint=str(payload.get("guidFingerprint", "")).strip().lower(),
        guid_count=max(0, int(payload.get("guidCount", 0))),
        guid_values=[str(item) for item in payload.get("guidValues", []) if isinstance(item, str)],
        guid_sample=[str(item) for item in payload.get("guidSample", []) if isinstance(item, str)][:32],
        asset_count=max(0, int(payload.get("assetCount", 0))),
        safe_asset_count=max(0, int(payload.get("safeAssetCount", 0))),
        unsafe_asset_count=max(0, int(payload.get("unsafeAssetCount", 0))),
    )
    package_name = str(payload.get("packageName", "package.unitypackage")) or "package.unitypackage"
    
    assets = None
    if "assets" in payload and isinstance(payload["assets"], list):
        assets = [
            ParsedAsset(
                asset_id=str(asset.get("assetId", "")),
                guid=str(asset.get("guid", "")),
                pathname=str(asset.get("pathname", "")),
                size=int(asset.get("size", 0)),
                tar_member_name="",
                has_meta=bool(asset.get("hasMeta", False)),
                meta_member_name=None,
                safe_path=bool(asset.get("safePath", True)),
            )
            for asset in payload["assets"]
            if isinstance(asset, dict)
        ]
    
    return identify_package(package_name, fingerprint, assets)


def load_identity_catalog(catalog_url: str) -> list[dict[str, str]] | None:
    global _catalog_cache

    raw_cache_ttl = os.getenv("UPI_IDENTITY_CACHE_SECONDS")
    if raw_cache_ttl is not None:
        cache_ttl_seconds = max(0.0, float(raw_cache_ttl))
    else:
        cache_ttl_seconds = 0.0 if _is_dev_mode() else 300.0

    now = time.time()
    if cache_ttl_seconds > 0 and _catalog_cache and now - _catalog_cache[0] < cache_ttl_seconds:
        return _catalog_cache[1]

    timeout = float(os.getenv("UPI_IDENTITY_TIMEOUT_SECONDS", "5"))
    try:
        with urlopen(catalog_url, timeout=timeout) as response:
            rows = list(csv.DictReader(response.read().decode("utf-8-sig").splitlines()))
    except (TimeoutError, URLError, ValueError):
        return _catalog_cache[1] if _catalog_cache else None

    if cache_ttl_seconds > 0:
        _catalog_cache = (now, rows)
    else:
        _catalog_cache = None

    return rows


def _match_by_hash(rows: list[dict[str, str]], fingerprint: PackageFingerprint) -> tuple[dict[str, str], str | None] | None:
    known_hashes = {fingerprint.md5.lower(), fingerprint.sha256.lower()}
    for row in rows:
        for candidate_hash, candidate_version in _parse_algorithmic_hashes(row.get("Known hashes", "")):
            if candidate_hash in known_hashes:
                return row, candidate_version
    return None


def _match_by_guids(rows: list[dict[str, str]], package_guid_set: set[str], package_guid_count: int) -> tuple[dict[str, str], float, int, str | None, set[str]] | None:
    best_match: tuple[dict[str, str], float, int, str | None, set[str]] | None = None
    for row in rows:
        for known_guid_set, candidate_version in _guid_match_candidates(row.get("Known GUIDs", "")):
            if not known_guid_set:
                continue

            overlap = len(package_guid_set & known_guid_set)
            if overlap == 0:
                continue

            coverage = overlap / len(known_guid_set)
            if coverage == 1.0:
                matched_guids = package_guid_set & known_guid_set
                return row, coverage, overlap, candidate_version, matched_guids

            is_better_match = best_match is None or coverage > best_match[1] or (coverage == best_match[1] and overlap > best_match[2])
            if len(known_guid_set) >= 3 and overlap >= 2 and is_better_match:
                matched_guids = package_guid_set & known_guid_set
                best_match = (row, coverage, overlap, candidate_version, matched_guids)

    return best_match


def _build_catalog_identity(
    row: dict[str, str],
    recognition_status: str,
    match_type: str,
    package_name: str,
    guid_coverage: float | None = None,
    matched_version: str | None = None,
    matched_guid_examples: list[str] | None = None,
    matched_file_pathnames: list[str] | None = None,
) -> PackageIdentity:
    display_name = _optional_str(row.get("Name"))
    author = _optional_str(row.get("Author"))
    thumbnail_url = _optional_str(row.get("Thumbnail URL"))
    source_links_column, source_links_raw = _row_value_with_key(
        row,
        "Source links",
        "Source Links",
        "Social links",
        "Social Links",
        "Social",
        "Social URL",
        "Social URLs",
        "Source",
        "Sources",
        "Source URL",
        "Source URLs",
    )
    source_links = _parse_source_links(source_links_raw)
    version = matched_version or _optional_str(_row_value(row, "Version", "version"))
    base_name = display_name
    package_label = display_name or package_name

    if recognition_status == "known-good":
        if version:
            message = f"GUID lineage matches a known file from {package_label}, and the package hash matches a known hash of the cataloged {version} release."
        else:
            message = f"GUID lineage matches a known file from {package_label}, and the package hash matches a known cataloged release."
    elif recognition_status == "known-custom":
        message = f"{package_label} matches a known base by GUIDs, but the package hash differs from the cataloged releases."
    elif recognition_status == "corrupt":
        if guid_coverage and guid_coverage > 0:
            coverage_percent = int(round(guid_coverage * 100))
            message = f"{package_label} only partially matches a known base by GUIDs ({coverage_percent}% coverage) and may be tampered or incomplete."
        else:
            message = f"{package_label} appears incomplete or corrupt."
    else:
        coverage_percent = int(round((guid_coverage or 0.0) * 100))
        if guid_coverage and guid_coverage > 0:
            message = f"{package_label} partially matches a known base by GUIDs ({coverage_percent}% coverage) and may be a custom variant."
        else:
            message = f"{package_label} did not match any known hash or GUID lineage in the catalog."

    return PackageIdentity(
        lookup_status="resolved",
        recognition_status=recognition_status,
        match_type=match_type,
        display_name=display_name,
        base_name=base_name,
        version=version,
        author=author,
        thumbnail_url=thumbnail_url,
        source_links=source_links,
        message=message,
        matched_guid_examples=matched_guid_examples,
        matched_file_pathnames=matched_file_pathnames,
        source_links_column=source_links_column,
        source_links_raw=_optional_str(source_links_raw),
    )


def fetch_remote_thumbnail_bytes(url: str, timeout_seconds: float) -> tuple[bytes, str | None]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http and https thumbnail URLs are supported.")

    with urlopen(url, timeout=timeout_seconds) as response:
        content_type = response.headers.get("Content-Type")
        return response.read(), content_type


def _optional_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _row_value(row: dict[str, str], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _row_value_with_key(row: dict[str, str], *keys: str) -> tuple[str | None, str]:
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return key, value
    return None, ""


def _parse_source_links(value: str) -> list[PackageSourceLink]:
    source_links: list[PackageSourceLink] = []
    for item in _split_source_values(value):
        explicit_label, raw_url = _parse_labeled_link(item)
        normalized_url = _normalize_source_url(raw_url)
        if not normalized_url:
            continue
        source_links.append(
            PackageSourceLink(
                label=explicit_label or _label_for_source_url(normalized_url),
                url=normalized_url,
            )
        )
    return source_links


def _split_source_values(value: str) -> list[str]:
    normalized = value.replace("\r", "\n")
    split_pattern = r"\n|\||;|,(?=\s*(?:https?://|www\.|\[|[A-Za-z0-9 _-]+\s*[:=]\s*(?:https?://|www\.)))"
    return [item.strip() for item in re.split(split_pattern, normalized) if item.strip()]


def _parse_labeled_link(value: str) -> tuple[str | None, str]:
    candidate = value.strip()
    if not candidate:
        return None, ""

    # Support Markdown-style links: [Label](https://example.com)
    if candidate.startswith("[") and "](" in candidate and candidate.endswith(")"):
        closing_bracket = candidate.find("](")
        label = _optional_str(candidate[1:closing_bracket])
        url = candidate[closing_bracket + 2 : -1].strip()
        return label, url

    # Support label=url and label:url formats.
    for separator in ("=", ":"):
        left, found, right = candidate.partition(separator)
        if not found:
            continue
        left_value = left.strip()
        right_value = right.strip()
        if left_value and right_value and _looks_like_url(right_value):
            return _optional_str(left_value), right_value

    return None, candidate


def _normalize_source_url(value: str) -> str | None:
    candidate = value.strip()
    if not candidate:
        return None

    if candidate.startswith("www."):
        candidate = f"https://{candidate}"

    if "://" not in candidate and _looks_like_url(candidate):
        candidate = f"https://{candidate}"

    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return candidate
    return None


def _looks_like_url(value: str) -> bool:
    candidate = value.strip().lower()
    if not candidate:
        return False
    if candidate.startswith(("http://", "https://", "www.")):
        return True
    return "." in candidate and " " not in candidate


def _label_for_source_url(value: str) -> str:
    hostname = urlparse(value).hostname or ""
    normalized_host = hostname.lower().removeprefix("www.")
    if normalized_host.endswith("gumroad.com"):
        return "Gumroad"
    if normalized_host.endswith("jinxxy.com"):
        return "Jinxxy"
    if normalized_host.endswith("itch.io"):
        return "Itch.io"
    return value


def _determine_guid_match_status(row: dict[str, str], guid_coverage: float, overlap: int) -> str:
    if guid_coverage == 1.0:
        return "known-custom"
    if guid_coverage >= 0.75 or overlap >= 3:
        return "corrupt"
    return "likely-custom"


def _guid_match_candidates(value: str) -> list[tuple[set[str], str | None]]:
    unversioned: set[str] = set()
    versioned: dict[str, set[str]] = {}

    for guid, version in _parse_versioned_values(value, _normalize_guid):
        if not guid:
            continue
        if version:
            versioned.setdefault(version, set()).add(guid)
        else:
            unversioned.add(guid)

    candidates: list[tuple[set[str], str | None]] = []
    for version, versioned_guids in versioned.items():
        candidate_guids = set(unversioned)
        candidate_guids.update(versioned_guids)
        candidates.append((candidate_guids, version))

    if unversioned and not versioned:
        candidates.append((set(unversioned), None))

    return candidates


def _parse_versioned_values(value: str, normalizer: Any) -> list[tuple[str, str | None]]:
    parsed_values: list[tuple[str, str | None]] = []
    for item in _split_multi_value(value):
        raw_value, separator, raw_version = item.partition("=")
        normalized_value = normalizer(raw_value if separator else item)
        if not normalized_value:
            continue
        parsed_values.append((normalized_value, _optional_str(raw_version) if separator else None))
    return parsed_values


def _split_multi_value(value: str) -> list[str]:
    normalized = value.replace(";", ":")
    return [item.strip() for item in normalized.split(":") if item.strip()]


def _parse_algorithmic_hashes(value: str) -> list[tuple[str, str | None]]:
    """Parse hashes in formats like 'sha256=hash=1.0' or 'md5=hash=v1.11' or plain hashes."""
    parsed_hashes: list[tuple[str, str | None]] = []
    for item in _split_multi_value(value):
        item = item.strip()
        if not item:
            continue
        
        # Check if this starts with algorithm prefix (sha256=, md5=, etc.)
        parts = item.split("=")
        if len(parts) >= 2 and parts[0].lower() in {"sha256", "md5", "sha1", "sha512"}:
            # Format: algorithm=hash=version
            algorithm = parts[0].lower()
            hash_part = parts[1]
            version = "=".join(parts[2:]) if len(parts) > 2 else None
            version = _optional_str(version) if version else None
            normalized_hash = hash_part.strip().lower()
        else:
            # Format: hash (or hash=version)
            raw_value, separator, raw_version = item.partition("=")
            normalized_hash = raw_value.strip().lower()
            version = _optional_str(raw_version) if separator else None
        
        if normalized_hash:
            parsed_hashes.append((normalized_hash, version))
    
    return parsed_hashes


def _normalize_hash(value: str) -> str:
    return value.strip().lower()


def _normalize_guid(value: str) -> str:
    return value.strip().lower()