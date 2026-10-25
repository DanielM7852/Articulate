"""Resend email delivery for the session recap."""

import httpx

RESEND_URL = "https://api.resend.com/emails"
MAX_ADDRESS_CHARS = 254


class EmailError(Exception):
    pass


def _plausible_address(to: str) -> bool:
    if not to or len(to) > MAX_ADDRESS_CHARS:
        return False
    if any(ch.isspace() or ch == "," for ch in to):
        return False
    if to.count("@") != 1:
        return False
    local, domain = to.split("@")
    return bool(local) and bool(domain)


async def send_email(
    client: httpx.AsyncClient,
    api_key: str,
    sender: str,
    to: str,
    subject: str,
    html: str,
    text: str,
    timeout_s: float = 15.0,
) -> str:
    if not _plausible_address(to):
        raise EmailError("Recipient address is not valid")
    try:
        response = await client.post(
            RESEND_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"from": sender, "to": [to], "subject": subject, "html": html, "text": text},
            timeout=timeout_s,
        )
    except httpx.HTTPError as exc:
        raise EmailError(f"Resend request failed: {type(exc).__name__}") from exc
    if not 200 <= response.status_code < 300:
        raise EmailError(f"Resend returned HTTP {response.status_code}")
    try:
        email_id = response.json().get("id")
    except (ValueError, AttributeError) as exc:
        raise EmailError("Resend response was not valid") from exc
    if not isinstance(email_id, str) or not email_id:
        raise EmailError("Resend response had no id")
    return email_id
