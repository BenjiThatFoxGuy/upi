from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ParsedAsset:
    asset_id: str
    guid: str
    pathname: str
    size: int
    tar_member_name: str
    has_meta: bool
    meta_member_name: str | None
    safe_path: bool


@dataclass(slots=True)
class PackageFingerprint:
    md5: str
    sha256: str
    guid_fingerprint: str
    guid_count: int
    guid_values: list[str]
    guid_sample: list[str]
    asset_count: int
    safe_asset_count: int
    unsafe_asset_count: int


@dataclass(slots=True)
class PackageSourceLink:
    label: str
    url: str


@dataclass(slots=True)
class PackageIdentity:
    lookup_status: str
    recognition_status: str
    match_type: str
    display_name: str | None
    base_name: str | None
    version: str | None
    author: str | None
    thumbnail_url: str | None
    source_links: list[PackageSourceLink]
    message: str


@dataclass(slots=True)
class StoredPackage:
    session_id: str
    package_name: str
    package_path: str
    assets: list[ParsedAsset]
    fingerprint: PackageFingerprint
    identity: PackageIdentity
