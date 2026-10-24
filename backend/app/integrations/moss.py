"""Moss cue retrieval.

The adapter queries a Moss index when project credentials and the moss package
are available. Candidates are then filtered to the local curated library, the
current exercise and finding, and cues already attempted.

A local metadata filter covers development and Moss outages. That path sets
backend=local_fallback and is not a working Moss integration.
"""

from dataclasses import dataclass, field

from app.config import Settings
from app.schemas import Cue, RetrievalInfo


@dataclass
class RetrievalQuery:
    exercise: str
    finding: str
    language: str
    attempted_cue_ids: list[str] = field(default_factory=list)


@dataclass
class RetrievalResult:
    info: RetrievalInfo
    cues: list[Cue]
    cue_reused: bool


class CueRetriever:
    def __init__(
        self,
        cues: list[Cue],
        review_notice: str,
        settings: Settings,
        moss_client=None,
        query_options_type=None,
    ) -> None:
        self._cues = cues
        self._notice = review_notice
        self._settings = settings
        self._client = moss_client
        self._query_options_type = query_options_type
        self._loaded = False

    async def retrieve(self, query: RetrievalQuery) -> RetrievalResult:
        preferred: list[str] | None = None
        backend = "local_fallback"
        disclosed = True
        reason = "moss_not_configured"
        if self._settings.moss_configured:
            try:
                preferred = await self._rank_with_moss(query)
                backend = "moss"
                disclosed = False
                reason = None
            except Exception as exc:  # noqa: BLE001 - outage falls back and is disclosed
                preferred = None
                backend = "local_fallback"
                disclosed = True
                reason = (
                    "moss_package_not_installed"
                    if "moss_package_not_installed" in str(exc)
                    else f"moss_error:{type(exc).__name__}"
                )
        cues, reused, narrowed = _select(self._cues, query, preferred)
        if preferred is not None and not narrowed:
            disclosed = True
            reason = "moss_candidates_not_applicable"
            backend = "local_fallback"
        return RetrievalResult(
            info=RetrievalInfo(
                backend=backend,  # type: ignore[arg-type]
                disclosed_fallback=disclosed,
                fallback_reason=reason,
                candidate_cue_ids=[cue.cue_id for cue in cues],
                draft_cue_ids=[cue.cue_id for cue in cues if cue.review_status != "reviewed"],
                review_notice=self._notice,
            ),
            cues=cues,
            cue_reused=reused,
        )

    async def _rank_with_moss(self, query: RetrievalQuery) -> list[str]:
        client = self._ensure_client()
        options_type = self._query_options_type
        if options_type is None:
            from moss import QueryOptions

            options_type = QueryOptions
        if not self._loaded:
            await client.load_index(self._settings.moss_index_name)
            self._loaded = True
        options = options_type(
            top_k=8,
            filter={
                "$and": [
                    {"field": "language", "condition": {"$eq": query.language}},
                    {
                        "field": "exercise",
                        "condition": {"$in": [query.exercise, "intonation_any"]},
                    },
                ]
            },
        )
        result = await client.query(
            self._settings.moss_index_name,
            f"{query.exercise} {query.finding} practice cue",
            options,
        )
        docs = getattr(result, "docs", []) or []
        return [str(doc.id) for doc in docs]

    def _ensure_client(self):
        if self._client is not None:
            return self._client
        try:
            from moss import MossClient
        except ImportError as exc:
            raise RuntimeError("moss_package_not_installed") from exc
        self._client = MossClient(self._settings.moss_project_id, self._settings.moss_project_key)
        return self._client


def _select(
    cues: list[Cue],
    query: RetrievalQuery,
    preferred_ids: list[str] | None,
) -> tuple[list[Cue], bool, bool]:
    applicable = [cue for cue in cues if _matches(cue, query)]
    narrowed = False
    pool = applicable
    if preferred_ids:
        preferred = {cue_id for cue_id in preferred_ids}
        preferred_pool = [cue for cue in applicable if cue.cue_id in preferred]
        if preferred_pool:
            pool = preferred_pool
            narrowed = True
    fresh = [cue for cue in pool if cue.cue_id not in set(query.attempted_cue_ids)]
    reused = False
    if fresh:
        pool = fresh
    elif pool:
        reused = True
    rank = {cue_id: index for index, cue_id in enumerate(preferred_ids or [])}

    def sort_key(cue: Cue) -> tuple:
        return (
            0 if cue.finding == query.finding else 1,
            0 if cue.exercise == query.exercise else 1,
            rank.get(cue.cue_id, 1000),
            cue.cue_id,
        )

    ordered = sorted(pool, key=sort_key)
    return ordered[:5], reused, narrowed


def _matches(cue: Cue, query: RetrievalQuery) -> bool:
    if cue.language != query.language:
        return False
    if cue.exercise not in {query.exercise, "intonation_any"}:
        return False
    if cue.finding != query.finding:
        return False
    return True


def plan_moss_sync(cues: list[Cue], index_name: str) -> list[dict]:
    """Describe the Moss upserts a commit run would send. This does not call Moss."""

    planned = []
    for cue in cues:
        planned.append(
            {
                "index_name": index_name,
                "id": cue.cue_id,
                "text": f"{cue.exercise} {cue.finding} {cue.instruction_text}",
                "metadata": {
                    "cue_id": cue.cue_id,
                    "exercise": cue.exercise,
                    "finding": cue.finding,
                    "language": cue.language,
                    "difficulty": cue.difficulty,
                    "review_status": cue.review_status,
                    "instruction_text": cue.instruction_text,
                    "source": cue.source,
                },
            }
        )
    return planned
