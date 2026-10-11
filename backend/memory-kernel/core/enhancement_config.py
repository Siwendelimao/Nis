"""
EnhancementConfigStore — 增强配置持久化存储。

管理识图/语音模型配置。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass
class EnhancementConfig:
    """原生增强配置。"""
    image_model_id: str = ""
    image_model_source: str = "shared"
    voice_model_id: str = ""
    voice_model_source: str = "shared"


class EnhancementConfigStore:
    """增强配置持久化存储。"""

    def __init__(self, config_dir: str | None = None) -> None:
        if config_dir is None:
            config_dir = os.path.join(os.path.expanduser("~"), ".nis_config")
        os.makedirs(config_dir, exist_ok=True)
        self._config_file = os.path.join(config_dir, "enhancement.json")

    def load(self) -> EnhancementConfig:
        if not os.path.exists(self._config_file):
            return EnhancementConfig()
        with open(self._config_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return EnhancementConfig(**data)

    def save(self, config: EnhancementConfig) -> None:
        with open(self._config_file, "w", encoding="utf-8") as f:
            json.dump(config.__dict__, f, ensure_ascii=False, indent=2)

    def update(self, **kwargs) -> EnhancementConfig:
        config = self.load()
        for key, value in kwargs.items():
            if hasattr(config, key):
                setattr(config, key, value)
        self.save(config)
        return config
