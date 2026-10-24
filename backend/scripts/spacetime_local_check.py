"""Local Spacetime checks for one learner and a two-learner classroom.

This does not call Claude or Cartesia. It creates fresh identities, claims the
worker role if it is still open, and prints timings. Tokens are not printed.

Usage, from the backend directory, with the local server already running:

    python scripts/spacetime_local_check.py
"""

import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3000"
DATABASE = __import__("os").environ.get("SPACETIMEDB_DATABASE", "articulate-local")


def identity() -> tuple[str, str]:
    request = urllib.request.Request(f"{BASE}/v1/identity", method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read().decode())
    return body["identity"], body["token"]


def call(token: str, reducer: str, args: list) -> tuple[int, str, float]:
    data = json.dumps(args).encode()
    request = urllib.request.Request(
        f"{BASE}/v1/database/{DATABASE}/call/{reducer}",
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            text = response.read().decode()
            status = response.status
    except urllib.error.HTTPError as exc:
        text = exc.read().decode()
        status = exc.code
    return status, text[:300], (time.perf_counter() - started) * 1000.0


def sql(token: str, query: str) -> str:
    request = urllib.request.Request(
        f"{BASE}/v1/database/{DATABASE}/sql",
        data=query.encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode()


def main() -> None:
    worker_identity, worker = identity()
    teacher_identity, teacher = identity()
    learner_a_identity, learner_a = identity()
    learner_b_identity, learner_b = identity()
    status, body, elapsed = call(worker, "become_worker", [])
    print(f"become_worker status={status} ms={elapsed:.1f} claimed={status < 400}")
    if status >= 400:
        print("worker role is already claimed; this process is not the worker")
        print(body)
        return
    token_path = __import__("pathlib").Path(__file__).resolve().parents[2] / ".tools" / "spacetime-worker.json"
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(
        json.dumps({"database": DATABASE, "url": BASE, "identity": worker_identity, "token": worker}),
        encoding="utf-8",
    )
    print(f"worker token saved to {token_path.name}")

    assert call(learner_a, "ensure_profile", ["Learner A", "a@example.com"])[0] < 400
    assert call(learner_b, "ensure_profile", ["Learner B", "b@example.com"])[0] < 400
    assert call(teacher, "create_classroom", ["room-1", "Demo room", "join-room-1"])[0] < 400
    assert call(learner_a, "join_classroom", ["join-room-1"])[0] < 400
    assert call(learner_b, "join_classroom", ["join-room-1"])[0] < 400
    assert call(learner_b, "create_classroom", ["room-stolen", "Nope", "nope"])[0] < 400
    denied = call(learner_b, "assign_exercise", ["asg-1", "room-1", "intonation_rising", "intonation-rising-ready", "pitch-v1"])
    print(f"cross_classroom_assign status={denied[0]}")
    assert denied[0] >= 400
    assert call(teacher, "assign_exercise", ["asg-1", "room-1", "intonation_rising", "intonation-rising-ready", "pitch-v1"])[0] < 400

    assert call(learner_a, "open_session", ["session-a", "intonation_rising", "device-a"])[0] < 400
    assert call(learner_a, "begin_attempt", ["session-a", "attempt-a", "intonation-rising-ready", "device-a"])[0] < 400
    frame = json.dumps([{"time_s": 0.0, "f0_hz": None, "voiced": False, "valid": False, "quality": None}])
    first = call(
        learner_a,
        "append_feature_chunk",
        ["attempt-a", 0, "device-a", "capture-a", 0, 16000, 256, 1024, "pitch-v1", "client_provisional", frame],
    )
    second = call(
        learner_a,
        "append_feature_chunk",
        ["attempt-a", 0, "device-a", "capture-a", 0, 16000, 256, 1024, "pitch-v1", "client_provisional", frame],
    )
    print(f"duplicate_chunk first={first[0]} second={second[0]}")
    assert first[0] < 400 and second[0] < 400
    stolen = call(learner_b, "append_feature_chunk", ["attempt-a", 1, "device-b", "capture-b", 0, 16000, 256, 1024, "pitch-v1", "client_provisional", frame])
    print(f"cross_user_chunk status={stolen[0]}")
    assert stolen[0] >= 400

    commit_args = [
        "attempt-a",
        "intonation_rising",
        "pitch-v1",
        "partial",
        "ending_direction_mismatch",
        "Let the ending rise.",
        "cue-rise-ending-draft",
        "repeat",
        "{}",
        "[]",
        False,
        1,
        "attempt-a:partial:ending_direction_mismatch",
    ]
    learner_commit = call(learner_a, "commit_verified", commit_args)
    print(f"learner_commit_rejected status={learner_commit[0]}")
    assert learner_commit[0] >= 400
    verified = call(worker, "commit_verified", commit_args)
    again = call(worker, "commit_verified", commit_args)
    print(f"verified status={verified[0]} ms={verified[2]:.1f} repeat={again[0]}")
    assert verified[0] < 400 and again[0] < 400
    spoken = call(worker, "mark_feedback_spoken", ["attempt-a:partial:ending_direction_mismatch"])
    spoken_again = call(worker, "mark_feedback_spoken", ["attempt-a:partial:ending_direction_mismatch"])
    print(f"spoken status={spoken[0]} repeat={spoken_again[0]}")
    progress = sql(learner_a, "SELECT usable_attempts, ending_mismatch_count FROM my_progress")
    other = sql(learner_b, "SELECT usable_attempts FROM my_progress")
    print("learner_a_progress")
    print(progress)
    print("learner_b_progress")
    print(other)

    samples = []
    assert call(learner_b, "open_session", ["session-b", "intonation_rising", "device-b"])[0] < 400
    assert call(learner_b, "begin_attempt", ["session-b", "attempt-b", "intonation-rising-ready", "device-b"])[0] < 400
    for sequence in range(20):
        status, _text, elapsed = call(
            learner_b,
            "append_feature_chunk",
            ["attempt-b", sequence, "device-b", "capture-b", sequence * 256, 16000, 256, 1024, "pitch-v1", "client_provisional", frame],
        )
        assert status < 400
        samples.append(elapsed)
    samples.sort()
    print(
        f"chunk_latency_ms n={len(samples)} p50={samples[len(samples)//2]:.1f} p95={samples[max(0, int(len(samples)*0.95)-1)]:.1f}"
    )
    print(
        "identities_created",
        json.dumps(
            {
                "worker": worker_identity,
                "teacher": teacher_identity,
                "learner_a": learner_a_identity,
                "learner_b": learner_b_identity,
            }
        ),
    )
if __name__ == "__main__":
    main()
