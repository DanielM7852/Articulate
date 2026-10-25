from app.classroom.owner import browser_database_uri

OWNER = "http://127.0.0.1:3000"


def test_local_sign_in_keeps_the_owner_uri():
    assert browser_database_uri(OWNER, enabled=False, host="pod-80.proxy.runpod.net", forwarded_proto="https") == OWNER


def test_public_host_uses_the_request_host():
    assert (
        browser_database_uri(OWNER, enabled=True, host="pod-80.proxy.runpod.net", forwarded_proto="https")
        == "https://pod-80.proxy.runpod.net"
    )


def test_localhost_request_stays_on_the_owner_uri():
    assert browser_database_uri(OWNER, enabled=True, host="127.0.0.1:8000", forwarded_proto="http") == OWNER


def test_private_proxy_host_uses_the_browser_origin():
    assert (
        browser_database_uri(
            OWNER,
            enabled=True,
            host="100.65.25.197",
            forwarded_proto="https",
            origin="https://lq1ms0f5forp7b-80.proxy.runpod.net",
        )
        == "https://lq1ms0f5forp7b-80.proxy.runpod.net"
    )


def test_private_proxy_host_uses_forwarded_host():
    assert (
        browser_database_uri(
            OWNER,
            enabled=True,
            host="100.65.25.197",
            forwarded_proto="https",
            forwarded_host="lq1ms0f5forp7b-80.proxy.runpod.net",
        )
        == "https://lq1ms0f5forp7b-80.proxy.runpod.net"
    )
