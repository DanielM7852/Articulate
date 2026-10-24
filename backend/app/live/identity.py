"""Signed guest identities shared by API replicas; display names never establish ownership.

This is browser/device authentication, not an account login. The random profile ID is
bound to an HttpOnly cookie. Replace issuance with verified account identities when
adding account recovery; keep the profile ownership checks at the API boundary.
"""

import hashlib
import hmac
import time
import uuid

from fastapi import HTTPException, Request, Response

COOKIE = "articulate_identity"


def _signature(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def read_identity(request: Request) -> str | None:
    settings = request.app.state.settings
    token = request.cookies.get(COOKIE, "")
    try:
        profile, expires, signature = token.split(".")
        if profile != f"p_{uuid.UUID(profile[2:]).hex}" or not profile.startswith("p_"):
            return None
        if int(expires) <= time.time():
            return None
        expected = _signature(settings.live_identity_secret, f"{profile}.{expires}")
        return profile if hmac.compare_digest(signature, expected) else None
    except (ValueError, TypeError, AttributeError):
        return None


def issue_identity(request: Request, response: Response) -> dict:
    settings = request.app.state.settings
    response.headers["Cache-Control"] = "no-store"
    if settings.live_coordination == "local":
        return {"shared": False, "profileId": None}
    profile = read_identity(request)
    if profile is None:
        profile = f"p_{uuid.uuid4().hex}"
        expires = int(time.time()) + settings.live_identity_ttl_s
        message = f"{profile}.{expires}"
        response.set_cookie(
            COOKIE, f"{message}.{_signature(settings.live_identity_secret, message)}",
            max_age=settings.live_identity_ttl_s, httponly=True,
            secure=settings.live_cookie_secure, samesite="strict", path="/v1",
        )
    return {"shared": True, "profileId": profile}


def authorize_profile(request: Request, profile_id: str) -> None:
    if request.app.state.settings.live_coordination == "local":
        return
    principal = read_identity(request)
    if principal is None:
        raise HTTPException(401, "identity_required")
    if principal != profile_id:
        raise HTTPException(403, "profile_mismatch")
