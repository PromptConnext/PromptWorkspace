import pytest

from app.config import Settings


def _settings(**overrides) -> Settings:
    defaults = dict(
        app_env="development",
        auth_mode="stub",
        cors_origins="http://localhost:3000,http://localhost:1420",
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
