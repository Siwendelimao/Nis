from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from partners.base import PartnerPlugin


PARTNER_REGISTRY: dict[str, type] = {}


def register_partner(cls: type) -> type:
    PARTNER_REGISTRY[cls.name] = cls
    return cls


def get_partner(name: str) -> Optional[type]:
    return PARTNER_REGISTRY.get(name)


def list_partners() -> list[str]:
    return list(PARTNER_REGISTRY.keys())


def create_partner(name: str, **kwargs) -> Optional[object]:
    cls = PARTNER_REGISTRY.get(name)
    if cls:
        return cls(**kwargs)
    return None
