import pytest

from app.audio import AudioCache
from app.config import Settings
from app.controller import Runtime
from app.persistence import Outbox
from app.providers import CueRepository, Reasoner


@pytest.fixture
def settings(tmp_path):
    return Settings(_env_file=None, data_dir=tmp_path, mock_mode=True, provider_deadline_seconds=0.25)


@pytest.fixture
def runtime(settings):
    box = Outbox(settings)
    repo = CueRepository(settings)
    reasoner = Reasoner(settings)
    r = Runtime(settings, repo, reasoner, box, AudioCache(settings.data_dir / "audio"))
    yield r
    box.close()
