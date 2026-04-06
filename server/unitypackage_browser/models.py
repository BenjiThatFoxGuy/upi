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
class StoredPackage:
    session_id: str
    package_name: str
    package_path: str
    assets: list[ParsedAsset]
