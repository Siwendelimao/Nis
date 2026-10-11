"""
ApiKeyVault — API Key 加密存储。

使用 Fernet 对称加密（AES-128-CBC + HMAC）。
密钥文件与加密数据分离存储。
"""

from __future__ import annotations

import json
import os
import stat

from cryptography.fernet import Fernet


class ApiKeyVault:
    """API Key 加密存储。"""

    def __init__(self, key_dir: str | None = None) -> None:
        if key_dir is None:
            key_dir = os.path.join(os.path.expanduser("~"), ".nis_config")
        self._key_dir = key_dir
        self._key_file = os.path.join(key_dir, ".vault_key")
        self._data_file = os.path.join(key_dir, "api_keys.enc")
        self._fernet = self._load_or_create_key()

    def _load_or_create_key(self) -> Fernet:
        if os.path.exists(self._key_file):
            with open(self._key_file, "rb") as f:
                key = f.read()
        else:
            os.makedirs(os.path.dirname(self._key_file), exist_ok=True)
            key = Fernet.generate_key()
            with open(self._key_file, "wb") as f:
                f.write(key)
            os.chmod(self._key_file, stat.S_IRUSR | stat.S_IWUSR)
        return Fernet(key)

    def encrypt(self, api_key: str) -> str:
        return self._fernet.encrypt(api_key.encode()).decode()

    def decrypt(self, encrypted_key: str) -> str:
        return self._fernet.decrypt(encrypted_key.encode()).decode()

    def get_key(self, provider: str) -> str | None:
        """获取指定厂商的解密后 API Key。"""
        if not os.path.exists(self._data_file):
            return None
        with open(self._data_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        encrypted = data.get(provider)
        if encrypted:
            return self.decrypt(encrypted)
        return None

    def set_key(self, provider: str, api_key: str) -> None:
        """加密并存储指定厂商的 API Key。"""
        data = {}
        if os.path.exists(self._data_file):
            with open(self._data_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        data[provider] = self.encrypt(api_key)
        with open(self._data_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
