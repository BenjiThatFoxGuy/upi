from __future__ import annotations

import tarfile
from collections import defaultdict
from pathlib import PurePosixPath

from .models import ParsedAsset


def _is_safe_unity_path(pathname: str) -> bool:
    normalized = pathname.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute():
        return False
    return all(part not in {"", ".", ".."} for part in path.parts)


def parse_package(package_path: str) -> list[ParsedAsset]:
    grouped_members: dict[str, dict[str, tarfile.TarInfo]] = defaultdict(dict)

    with tarfile.open(package_path, mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or "/" not in member.name:
                continue

            guid, leaf_name = member.name.split("/", 1)
            grouped_members[guid][leaf_name] = member

        assets: list[ParsedAsset] = []

        for guid, members in grouped_members.items():
            pathname_member = members.get("pathname")
            asset_member = members.get("asset")

            if pathname_member is None or asset_member is None:
                continue

            extracted = archive.extractfile(pathname_member)
            if extracted is None:
                continue

            pathname = extracted.read().decode("utf-8", errors="replace").strip()
            safe_path = _is_safe_unity_path(pathname)
            asset_id = f"{guid}:{pathname}"

            assets.append(
                ParsedAsset(
                    asset_id=asset_id,
                    guid=guid,
                    pathname=pathname,
                    size=asset_member.size,
                    tar_member_name=asset_member.name,
                    has_meta="asset.meta" in members,
                    meta_member_name=members.get("asset.meta").name if "asset.meta" in members else None,
                    safe_path=safe_path,
                )
            )

    assets.sort(key=lambda item: item.pathname.lower())
    return assets
