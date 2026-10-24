"""Claude structured-output client.

The SDK helper ``messages.parse`` sends the Pydantic schema as
``output_config.format``. This module reuses one client and retries only
transient API failures, up to the configured bound.
"""

import asyncio

from app.config import Settings
from app.errors import CoachValidationError, ProviderNotConfigured
from app.reasoning.prompts import SYSTEM_PROMPT, render_user_message
from app.schemas import CoachOutput, Cue, EvidenceItem


class ClaudeCoach:
    def __init__(self, settings: Settings, client=None) -> None:
        self._settings = settings
        self._client = client

    async def complete(
        self,
        *,
        finding: str,
        evidence: list[EvidenceItem],
        cues: list[Cue],
        history_summary: str,
        content_verified: bool,
        intended_pattern: str,
        exercise: str,
    ) -> CoachOutput:
        if self._client is None and not self._settings.anthropic_configured:
            raise ProviderNotConfigured("anthropic_not_configured")
        client = self._client or self._build_client()
        message = render_user_message(
            finding=finding,
            evidence=evidence,
            cues=cues,
            history_summary=history_summary,
            content_verified=content_verified,
            intended_pattern=intended_pattern,
            exercise=exercise,
        )
        last_error: Exception | None = None
        for attempt in range(self._settings.max_provider_retries + 1):
            try:
                response = await asyncio.to_thread(self._parse, client, message)
                parsed = getattr(response, "parsed_output", None)
                if parsed is None:
                    raise CoachValidationError("empty_model_output")
                if isinstance(parsed, CoachOutput):
                    return parsed
                return CoachOutput.model_validate(parsed)
            except (ProviderNotConfigured, CoachValidationError):
                raise
            except Exception as exc:  # noqa: BLE001 - classified below
                last_error = exc
                if not _retryable(exc) or attempt >= self._settings.max_provider_retries:
                    raise
                await asyncio.sleep(0.2)
        assert last_error is not None
        raise last_error

    def _build_client(self):
        from anthropic import Anthropic

        self._client = Anthropic(
            api_key=self._settings.anthropic_api_key,
            max_retries=0,
            timeout=self._settings.reasoning_timeout_s,
        )
        return self._client

    def _parse(self, client, message: str):
        return client.messages.parse(
            model=self._settings.anthropic_model,
            max_tokens=800,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": message}],
            output_format=CoachOutput,
        )


def _retryable(exc: Exception) -> bool:
    try:
        from anthropic import (
            APIConnectionError,
            APITimeoutError,
            InternalServerError,
            RateLimitError,
        )
    except ImportError:
        return False
    return isinstance(exc, (APIConnectionError, APITimeoutError, InternalServerError, RateLimitError))
