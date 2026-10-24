from app.config import Settings


def test_secrets_file_overrides_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    env = tmp_path / ".env"
    secrets = tmp_path / ".env.secrets"
    env.write_text("ANTHROPIC_API_KEY=from-env\nLIVE_HISTORY_LIMIT=5\n", encoding="utf-8")
    secrets.write_text("ANTHROPIC_API_KEY=from-secrets\n", encoding="utf-8")
    s = Settings(_env_file=(env, secrets))
    assert s.anthropic_api_key == "from-secrets"
    assert s.live_history_limit == 5


def test_missing_env_files_are_fine(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    s = Settings(_env_file=(tmp_path / "nope.env", tmp_path / "nope.secrets"))
    assert s.anthropic_api_key is None and not s.spacetime_configured


def test_default_env_files_are_anchored_to_backend_dir():
    files = Settings.model_config["env_file"]
    assert [f.name for f in files] == [".env", ".env.secrets"]
    assert all(f.is_absolute() and f.parent.name == "backend" for f in files)
