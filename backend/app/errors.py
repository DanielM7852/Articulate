"""Expected backend failures."""


class ArticulateError(Exception):
    """Base error that routes can turn into a client response."""

    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class UnknownReferenceError(ArticulateError):
    def __init__(self, reference_id: str) -> None:
        super().__init__(
            "unknown_reference",
            f"Unknown reference_id '{reference_id}'.",
            status_code=404,
        )


class StaleAttemptError(ArticulateError):
    def __init__(self, session_id: str, attempt_id: str) -> None:
        super().__init__(
            "stale_attempt",
            "This attempt is no longer the active attempt for the session.",
            status_code=409,
        )
        self.session_id = session_id
        self.attempt_id = attempt_id


class AudioRejected(ArticulateError):
    """The upload cannot be analyzed. The route returns status=failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, status_code=200)


class ProviderNotConfigured(ArticulateError):
    def __init__(self, code: str) -> None:
        super().__init__(code, code, status_code=200)


class CoachValidationError(ArticulateError):
    def __init__(self, code: str) -> None:
        super().__init__(code, code, status_code=200)
