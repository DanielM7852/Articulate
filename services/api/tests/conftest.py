import shutil
from uuid import uuid4

import pytest

from app.audio import AudioCache
from app.config import ROOT, Settings
from app.controller import Runtime
from app.persistence import Outbox
from app.providers import CueRepository, Reasoner


@pytest.fixture
def settings():
    path = ROOT / ".data" / "test_runs" / str(uuid4())
    path.mkdir(parents=True, exist_ok=True)
    yield Settings(_env_file=None, data_dir=path, mock_mode=True, provider_deadline_seconds=0.25)
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture
def runtime(settings):
    box = Outbox(settings)
    repo = CueRepository(settings)
    reasoner = Reasoner(settings)
    r = Runtime(settings, repo, reasoner, box, AudioCache(settings.data_dir / "audio"))
    yield r
    box.close()
