#!/usr/bin/env python3
"""Run the drift detector over the live world ledger; enforce soft holds.

This is the community round's supervision loop, one invocation per
window. It is ``tools/drift/enforce.py`` (builder-ide build #3,
``core/drift``) with the brief's own narrowing applied:

* the **pause file is ON for the bots** — the world reads it at its
  admission seam (``reflex/agent_world_reflex/service.py``) and yields
  politely;
* **dry-run is off only for soft holds**: a ``soft`` entry (one agent
  waits on its own branch) is written; ``tier`` and ``hard`` are
  logged as dry-run lines and a human decides them — an automated
  standing-aside of the whole world is not this seat's call to make.

Everything else is the shipped detector: the tuned-from-calibration
config, the state (not the fires) at the last window, the ladder's
plan, and the pause file's merge semantics (another operator's entry
is never dropped; every entry lapses at its TTL unless renewed).

Run it from a loop (ops/drift-watch.sh); it is CPU-only, read-only
over the ledger, and writes only the pause file and its own log.

    python3 ops/drift-watch.py            # one window
    python3 ops/drift-watch.py --status   # what is in force, no detector
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("AW_DRIFT_HOME", str(Path.home() / "lm-wt" / "drift-pause")))
sys.path.insert(0, str(HOME))

from core.drift.config import DriftConfig, GateSpec  # noqa: E402
from core.drift.detect import DriftDetector, SOFT  # noqa: E402
from core.drift.gate import RATE  # noqa: E402
from core.drift.ledger import build_series  # noqa: E402
from core.drift.pause import PauseFile  # noqa: E402

CALIBRATION = HOME / "docs" / "lab" / "drift-pause-dataset" / "calibration.json"
LEDGER = Path(
    os.environ.get(
        "AW_LEDGER",
        str(Path.home() / "lm-wt" / "agent-world" / "runtime" / "world-ledger.sqlite3"),
    )
)
PAUSE_FILE = Path(
    os.environ.get(
        "AW_DRIFT_PAUSE",
        str(Path.home() / "lm-wt" / "agent-world" / "runtime" / "drift-pause.json"),
    )
)
LOG = Path(
    os.environ.get(
        "AW_DRIFT_WATCH_LOG",
        str(Path.home() / "lm-wt" / "agent-world" / "runtime" / "logs" / "drift-watch.log"),
    )
)
TTL_SECONDS = float(os.environ.get("AW_DRIFT_TTL", "1800"))


def tuned() -> DriftConfig:
    """The shipped operating point (enforce.py's eight lines, as they are)."""
    calibration = json.loads(CALIBRATION.read_text())
    tuned_config = DriftConfig()
    mode = RATE
    for signal, point in calibration["combined"][mode]["thresholds"].items():
        gate = tuned_config.gate_for(signal)
        tuned_config = tuned_config.with_thresholds(
            **{
                signal: GateSpec(
                    enter=point["enter"],
                    exit=point["enter"] * 0.6,
                    level_exit=point.get("level_exit", 0.0),
                    dwell_up=gate.dwell_up,
                    dwell_down=gate.dwell_down,
                )
            }
        )
    return tuned_config


def log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with LOG.open("a") as handle:
        handle.write(f"{stamp} {line}\n")


def one_window(now: float | None = None) -> int:
    clock = now if now is not None else time.time()
    series = build_series(str(LEDGER))
    if not series.windows:
        log("no windows in the ledger yet; nothing to gate")
        return 0
    detection = DriftDetector(tuned()).run(series)
    window = series.windows[-1].at
    # The ladder's plan for the last window, exactly as enforce.py
    # builds it — then the brief's narrowing: soft enforced, the rest
    # dry-run.
    from core.drift.pause import plan_from_state

    plan = plan_from_state(detection, window, config=tuned(), now=clock, ttl_seconds=TTL_SECONDS)
    for line in plan.lines:
        log(f"plan: {line}")
    if not plan.entries:
        # Nothing in alarm. Soft entries lapse at their TTL on their
        # own; the pause file is not rewritten, because another
        # operator's entry is not this watcher's to drop.
        return 0
    soft = {actor: entry for actor, entry in plan.entries.items() if entry.level == SOFT}
    held = {a: e for a, e in plan.entries.items() if a not in soft}
    if soft:
        pause = PauseFile(PAUSE_FILE)
        pause.merge(soft, now=clock)
        for actor, entry in sorted(soft.items()):
            log(f"enforced soft hold: {actor} ({entry.reason})")
    for actor, entry in sorted(held.items()):
        log(f"dry-run {entry.level} (a human's call): {actor} ({entry.reason})")
    return len(soft) + len(held)


def status() -> int:
    entries = PauseFile(PAUSE_FILE).read()
    if not entries:
        print("no pauses in force")
        return 0
    for actor, entry in sorted(entries.items()):
        until = (
            time.strftime("%H:%M:%SZ", time.gmtime(entry.until)) if entry.until else "renewed"
        )
        print(f"{actor}: {entry.level} until {until} — {entry.reason}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true", help="print the pauses in force")
    parser.add_argument(
        "--loop",
        type=float,
        metavar="SECONDS",
        help="run one window per interval, forever (never dies on an error)",
    )
    args = parser.parse_args(argv)
    if args.status:
        return status()
    if args.loop:
        while True:
            try:
                one_window()
            except Exception as exc:  # the watcher never takes the world down
                log(f"watcher error: {type(exc).__name__}: {exc}")
            time.sleep(args.loop)
    try:
        return one_window()
    except Exception as exc:  # the watcher never takes the world down
        log(f"watcher error: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
