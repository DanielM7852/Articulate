import json

import httpx
import pytest

from app.integrations.resend_email import EmailError, send_email


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_send_email_success_returns_id_and_sends_expected_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "abc123"})

    async with _client(handler) as client:
        result = await send_email(client, "key", "Ava <a@x.com>", "me@x.com", "Hi", "<p>h</p>", "h")
    assert result == "abc123"
    assert seen["url"] == "https://api.resend.com/emails"
    assert seen["auth"] == "Bearer key"
    assert seen["body"] == {
        "from": "Ava <a@x.com>",
        "to": ["me@x.com"],
        "subject": "Hi",
        "html": "<p>h</p>",
        "text": "h",
    }


async def test_send_email_non_2xx_raises():
    async with _client(lambda r: httpx.Response(422, json={"message": "no"})) as client:
        with pytest.raises(EmailError):
            await send_email(client, "key", "a@x.com", "me@x.com", "s", "h", "t")


async def test_send_email_missing_id_raises():
    async with _client(lambda r: httpx.Response(200, json={})) as client:
        with pytest.raises(EmailError):
            await send_email(client, "key", "a@x.com", "me@x.com", "s", "h", "t")


async def test_send_email_transport_error_raises():
    def handler(request):
        raise httpx.ConnectError("boom")

    async with _client(handler) as client:
        with pytest.raises(EmailError):
            await send_email(client, "key", "a@x.com", "me@x.com", "s", "h", "t")


@pytest.mark.parametrize(
    "bad",
    ["", "nope", "a@b@c.com", "a b@c.com", "a@c.com,b@c.com", "a@c.com\nb@c.com", "@c.com", "a@", "a" * 250 + "@c.com"],
)
async def test_bad_address_rejected_without_request(bad):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"id": "x"})

    async with _client(handler) as client:
        with pytest.raises(EmailError):
            await send_email(client, "key", "a@x.com", bad, "s", "h", "t")
    assert calls == []
