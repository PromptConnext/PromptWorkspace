"""Server-side secret store for workspace-BYO model keys (M9).

Unlike Jira credentials (a single server-env secret, see app/config.py), each
workspace admin supplies its own model API key dynamically. `secret_ref` is
opaque ciphertext: only the server (holding `RAG_KEY_ENCRYPTION_KEY`, an env
var never written to Supabase) can turn it back into the plaintext key. No
plaintext key material is ever persisted, matching ADR 0011's "no key
material in Postgres."
"""

from __future__ import annotations

import abc
import base64


class SecretStore(abc.ABC):
    @abc.abstractmethod
    def encrypt(self, plaintext: str) -> str:
        """Return an opaque ciphertext ref safe to store in Postgres."""

    @abc.abstractmethod
    def decrypt(self, secret_ref: str) -> str: ...


class MemorySecretStore(SecretStore):
    """Dev/test store used with `data_backend=memory`, which never persists
    beyond the process anyway — plain base64 keeps it dependency-free, not a
    real encryption claim."""

    def encrypt(self, plaintext: str) -> str:
        return base64.urlsafe_b64encode(plaintext.encode()).decode()

    def decrypt(self, secret_ref: str) -> str:
        return base64.urlsafe_b64decode(secret_ref.encode()).decode()


class FernetSecretStore(SecretStore):
    """Production store: symmetric encryption keyed by `RAG_KEY_ENCRYPTION_KEY`.
    Requires the `cryptography` package, already pulled in by `PyJWT[crypto]`.
    """

    def __init__(self, key: str) -> None:
        from cryptography.fernet import Fernet  # lazy import

        self._fernet = Fernet(key.encode())

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, secret_ref: str) -> str:
        return self._fernet.decrypt(secret_ref.encode()).decode()


def build_secret_store(rag_key_encryption_key: str) -> SecretStore:
    if rag_key_encryption_key:
        return FernetSecretStore(rag_key_encryption_key)
    return MemorySecretStore()
