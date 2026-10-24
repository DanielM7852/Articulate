import json
from uuid import uuid4

import httpx

from app.persistence import Outbox


def test_outbox_survives_restart_and_deduplicates(settings):
    event = {"event_id": str(uuid4()), "session_id": str(uuid4()), "type": "session.state", "payload": {}}
    box = Outbox(settings)
    box.append(event)
    box.append(event)
    assert box.pending() == 1
    box.close()
    box = Outbox(settings)
    assert box.pending() == 1
    box.close()


async def test_retry_preserves_ids_and_http_argument_order(settings):
    settings.mock_mode = False
    settings.spacetimedb_database = "private-demo"
    settings.spacetimedb_token = "test-token"
    box = Outbox(settings)
    event = {"event_id": str(uuid4()), "session_id": str(uuid4()), "type": "session.state", "payload": {}}
    box.append(event)
    calls = []

    def handle(req):
        calls.append(req)
        return httpx.Response(503 if len(calls) == 1 else 200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        await box.flush(client)
        assert box.pending() == 1
        box.db.execute("UPDATE events SET next_try=0")
        box.db.commit()
        await box.flush(client)
    assert box.pending() == 0
    assert calls[0].content == calls[1].content
    assert json.loads(calls[0].content) == [json.dumps(event)]
    assert calls[0].headers["Authorization"] == "Bearer test-token"
    box.close()
