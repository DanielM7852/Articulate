"""Wire the default in-process backend."""

from app.config import Settings
from app.audio.content import ContentVerifier
from app.audio.gateway import ReferenceLibrary
from app.integrations.anthropic_client import ClaudeCoach
from app.integrations.spacetimedb import SpacetimeClient
from app.integrations.cues import load_cue_library
from app.integrations.moss import CueRetriever
from app.progress import ProgressBus
from app.reasoning.orchestrate import Orchestrator
from app.storage.local import LocalSessionStore


def build_orchestrator(settings: Settings) -> Orchestrator:
    notice, cues = load_cue_library()
    return Orchestrator(
        settings=settings,
        store=LocalSessionStore(settings.store_dir),
        retriever=CueRetriever(cues, notice, settings),
        coach=ClaudeCoach(settings),
        progress=ProgressBus(),
        references=ReferenceLibrary(settings),
        verifier=ContentVerifier(),
        spacetime=SpacetimeClient.from_settings(settings),
    )
