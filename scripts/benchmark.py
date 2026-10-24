"""Repeatable local-controller benchmark. Does not measure the browser or real providers."""

import argparse
import asyncio
import json
import os
import platform
import statistics
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/api"))
from app.audio import AudioCache
from app.config import Settings
from app.controller import Runtime
from app.features import synthetic_frame
from app.persistence import Outbox
from app.providers import CueRepository, Reasoner
from app.schemas import Command


def stats(values):
    ordered = sorted(values)
    return (
        {
            "runs": len(values),
            "median_ms": round(statistics.median(ordered), 3),
            "p95_ms": round(ordered[int(0.95 * (len(ordered) - 1))], 3),
        }
        if values
        else {"runs": 0}
    )


def cold_process_startups(runs, directory):
    durations, failures = [], 0
    for index in range(runs):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {**os.environ, "MOCK_MODE": "true", "DATA_DIR": str(Path(directory) / f"boot-{index}")}
        started = time.perf_counter()
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--app-dir",
                "services/api",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-access-log",
                "--log-level",
                "error",
            ],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            with httpx.Client(timeout=0.2, trust_env=False) as client:
                while time.perf_counter() - started < 10:
                    if process.poll() is not None:
                        raise RuntimeError("API startup exited")
                    try:
                        if client.get(f"http://127.0.0.1:{port}/health/ready").status_code == 200:
                            durations.append((time.perf_counter() - started) * 1000)
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.01)
                else:
                    raise TimeoutError("API startup deadline")
        except (RuntimeError, TimeoutError):
            failures += 1
        finally:
            process.terminate()
            process.wait(timeout=5)
    return {
        **stats(durations),
        "failures": failures,
        "boundary": "Python process launch to localhost /health/ready response; mocked providers",
    }


async def benchmark(runs):
    report = {
        "mode": "mock only; synthetic features and diagnostic tone",
        "python": platform.python_version(),
        "platform": platform.platform(),
        "clock": "Parent perf_counter for cold process launch; controller perf_counter for feedback stages",
        "environment_notes": "Local development workstation; concurrent development work may affect timing.",
        "limitations": "Feedback cases measure controller enqueue only. Cold controller case includes new repository/runtime initialization; cold_process_startup measures actual process launch to readiness separately. No browser sound, real providers or database network.",
        "cases": {},
    }
    with tempfile.TemporaryDirectory() as directory:
        report["cold_process_startup"] = cold_process_startups(runs, directory)
        settings = Settings(
            _env_file=None, mock_mode=True, data_dir=Path(directory), provider_deadline_seconds=3
        )
        box = Outbox(settings)
        cache = AudioCache(settings.data_dir / "audio")
        repo = CueRepository(settings)
        reasoner = Reasoner(settings)
        for case in ("cold_controller_uncached", "warm_uncached", "warm_cached"):
            visible, first_audio, total = [], [], []
            failures = 0
            for _ in range(runs):
                if case != "warm_cached":
                    for path in cache.path.glob("*.json"):
                        path.unlink()
                started = time.perf_counter()
                r = Runtime(
                    settings,
                    repo if case != "cold_controller_uncached" else CueRepository(settings),
                    reasoner,
                    box,
                    cache,
                )
                r.session.audio_enabled = True
                r.attempt_id = uuid4()
                r.generation_id = uuid4()
                r.session.state = "capturing"
                r.frames = [synthetic_frame("i", i) for i in range(20)]
                r.processed_sample = 19200
                events, audio = asyncio.Queue(maxsize=128), asyncio.Queue(maxsize=64)
                r.subscribers.add(events)
                r.audio_subscribers.add(audio)
                if case != "cold_controller_uncached":
                    started = time.perf_counter()
                try:
                    await r.command(
                        Command(
                            command_id=uuid4(),
                            expected_revision=0,
                            payload={"type": "attempt.end", "final_sample": 0},
                        )
                    )
                    async with asyncio.timeout(4):
                        while (await events.get())["type"] != "coach.decision":
                            pass
                        visible.append((time.perf_counter() - started) * 1000)
                        while not isinstance(await audio.get(), bytes):
                            pass
                        first_audio.append((time.perf_counter() - started) * 1000)
                        await r.feedback_task
                    total.append((time.perf_counter() - started) * 1000)
                except Exception:
                    failures += 1
                finally:
                    await r.close()
            report["cases"][case] = {
                "visible_enqueue": stats(visible),
                "first_pcm_enqueue": stats(first_audio),
                "completion": stats(total),
                "failures": failures,
            }
        box.close()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/latency.json")
    args = parser.parse_args()
    result = asyncio.run(benchmark(args.runs))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
