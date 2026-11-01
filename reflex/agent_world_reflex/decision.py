"""The decision model: d1-2B through builder-ide's judge.

The reflex must be fast, and the world must not stop when the model is
busy or down. Two rules come from ``docs/design/three-minds.md``:

* **the mediator never blocks the reflex** — and here the decision model
  never blocks the world either. Every ask has a deadline
  (``never-wait``, ``docs/lab/exp-never-wait.md``): past the deadline the
  best answer so far commits, and a late answer is recorded as a
  *supersede*, never as an edit to history.
* **every attempt is recorded** — the judge writes a ``judge.verdict`` row
  for every ask, including the ones it refused.

If the model cannot be reached at all, the world falls back to the
bandit's own prior and says so. The world keeps working; the log says
what happened.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Sequence

from .ledger import ledger_paths

ledger_paths()

from core.judge.backends import D1Backend, JudgeRefusal  # noqa: E402
from core.judge.judge import Judge, JudgeAnswer  # noqa: E402
from core.judge.models import Question  # noqa: E402

__all__ = ["DecisionModel", "make_choice_question"]


def make_choice_question(
    qid: str,
    *,
    role: str,
    options: dict[str, str],
    instructions: str = "",
) -> Question:
    """One choice over the skills a bot may do.

    The options are the skill ids and what they are for; the instruction
    says what the bot is trying to do. The judge answers with a
    probability per option, and the argmax is the answer.
    """
    text = instructions or (
        f"A {role} builder in a Minecraft world must choose the next thing to do. "
        "Which option serves its role best right now?"
    )
    return Question(qid=qid, kind="choice", instructions=text, criteria=dict(options))


class DecisionModel:
    """d1-2B, served once on the Thor and shared by every bot."""

    def __init__(
        self,
        *,
        port: int = 8094,
        model: str = "d1-2B",
        ledger: Any | None = None,
        deadline_seconds: float = 3.0,
        timeout: float = 30.0,
    ) -> None:
        self.backend = D1Backend(port=port, model=model, timeout=timeout)
        self.judge = Judge(backend=self.backend, ledger=ledger)
        self.deadline_seconds = deadline_seconds
        self._lock = threading.Lock()
        self.calls = 0
        self.failures = 0
        self.total_latency = 0.0
        self.total_questions = 0

    @property
    def available(self) -> bool:
        return True

    def ask(
        self,
        *,
        task: str,
        state: str,
        questions: Sequence[Question],
    ) -> JudgeAnswer:
        """Ask one pack over one state.

        One pack means **one** call to the model, no matter how many bots
        are in it. That is the whole reason the world shares one server:
        the per-question saving of the shared prefix is what makes a
        per-tick decision affordable for every builder at once.
        """
        started = time.monotonic()
        try:
            answer = self.judge.judge(
                task,
                state,
                list(questions),
                deadline_seconds=self.deadline_seconds,
            )
        finally:
            latency = time.monotonic() - started
            with self._lock:
                self.calls += 1
                self.total_latency += latency
                self.total_questions += len(questions)
        return answer

    def try_ask(
        self,
        *,
        task: str,
        state: str,
        questions: Sequence[Question],
    ) -> JudgeAnswer | None:
        """Ask, and never raise. A model that cannot be reached is a fact."""
        try:
            return self.ask(task=task, state=state, questions=questions)
        except (JudgeRefusal, OSError, ValueError, RuntimeError) as exc:
            with self._lock:
                self.failures += 1
            self.last_error = f"{type(exc).__name__}: {exc}"
            return None

    def stats(self) -> dict[str, Any]:
        with self._lock:
            calls = self.calls
            failures = self.failures
            latency = self.total_latency
            questions = self.total_questions
        return {
            "backend": self.backend.name,
            "model": self.backend.model,
            "calls": calls,
            "failures": failures,
            "questions": questions,
            "questions_per_call": round(questions / calls, 2) if calls else 0.0,
            "mean_latency_ms": round(latency / calls * 1000, 1) if calls else 0.0,
        }
