import pytest

from app.config import Settings


def _settings(**overrides) -> Settings:
    # `sentry_dsn` is pinned to a configured-looking value so these tests keep
    # asserting on the CORS/auth branches alone; the error-reporting warning
    # branch added by plan 0021 M2 has its own coverage in
    # tests/test_error_reporting.py.
    defaults = dict(
        app_env="development",
        auth_mode="stub",
        cors_origins="http://localhost:3000,http://localhost:1420",
        sentry_dsn="http://publickey@127.0.0.1:9/0",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def test_stub_auth_in_production_raises():
    settings = _settings(app_env="production", auth_mode="stub")
    with pytest.raises(RuntimeError, match="AUTH_MODE=supabase"):
        settings.require_production_safety()


def test_supabase_auth_in_production_does_not_raise():
    settings = _settings(app_env="production", auth_mode="supabase")
    settings.require_production_safety()


def test_cors_still_localhost_in_production_warns():
    settings = _settings(
        app_env="production",
        auth_mode="supabase",
        cors_origins="http://localhost:3000,http://localhost:1420",
    )
    warnings = settings.require_production_safety()
    assert len(warnings) == 1
    assert "CORS_ORIGINS" in warnings[0]


def test_cors_real_origin_in_production_no_warning():
    settings = _settings(
        app_env="production",
        auth_mode="supabase",
        cors_origins="https://app.promptconnext.com",
    )
    warnings = settings.require_production_safety()
    assert warnings == []


def test_non_production_stub_auth_does_not_raise():
    settings = _settings(app_env="development", auth_mode="stub")
    settings.require_production_safety()


def test_supabase_backend_without_rag_key_refuses_to_boot():
    settings = _settings(
        data_backend="supabase",
        supabase_url="https://ref.supabase.co",
        supabase_key="service-key",
        rag_key_encryption_key="",
    )
    with pytest.raises(RuntimeError, match="RAG_KEY_ENCRYPTION_KEY"):
        settings.require_supabase()


def test_supabase_backend_with_rag_key_boots():
    settings = _settings(
        data_backend="supabase",
        supabase_url="https://ref.supabase.co",
        supabase_key="service-key",
        rag_key_encryption_key="a-fernet-key",
    )
    settings.require_supabase()


def test_memory_backend_without_rag_key_boots():
    _settings(data_backend="memory", rag_key_encryption_key="").require_supabase()


@pytest.mark.parametrize("app_env", ["Production", " PRODUCTION ", "production\n"])
def test_stub_auth_in_production_raises_whatever_the_case(app_env):
    settings = _settings(app_env=app_env, auth_mode="stub")
    with pytest.raises(RuntimeError, match="AUTH_MODE=supabase"):
        settings.require_production_safety()


def test_cors_warning_applies_to_mixed_case_production():
    settings = _settings(app_env="Production", auth_mode="supabase")
    warnings = settings.require_production_safety()
    assert len(warnings) == 1
    assert "CORS_ORIGINS" in warnings[0]


def test_valid_fernet_key_passes():
    from cryptography.fernet import Fernet

    _settings(rag_key_encryption_key=Fernet.generate_key().decode()).require_valid_encryption_key()


def test_unset_encryption_key_is_not_validated():
    _settings(rag_key_encryption_key="").require_valid_encryption_key()


@pytest.mark.parametrize("key", ["not-a-key", "c2hvcnQ=", "x" * 44])
def test_malformed_fernet_key_refuses_to_boot(key):
    with pytest.raises(RuntimeError, match="RAG_KEY_ENCRYPTION_KEY is not a valid Fernet key"):
        _settings(rag_key_encryption_key=key).require_valid_encryption_key()


def test_build_repository_validates_the_encryption_key():
    from app.main import _build_repository

    with pytest.raises(RuntimeError, match="not a valid Fernet key"):
        _build_repository(_settings(rag_key_encryption_key="not-a-key"))
