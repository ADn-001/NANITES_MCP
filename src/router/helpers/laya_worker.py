"""
Laya worker: a LONG-LIVED process, one JSON object per line on stdin/stdout.

Same rationale as the Needle worker — a per-request interpreter pays a model
load every call, and measured cold start is over a minute on a cold cache.

The reason this file exists at all, rather than a shared generic worker:

  Laya's questions must be asked in ONE forward pass. `predict` accepts a whole
  questions dict and answers every entry from a single pass, so asking six
  questions as six calls would pay the model cost six times for one decision.
  Batching is the difference between a usable pre-flight guard and a feature
  nobody tolerates.

Protocol:

    -> {"op": "ping"}
    <- {"ok": true, "warmed": true}

    -> {"op": "predict", "state": "...", "questions": {...}, "model": "..."}
    <- {"ok": true, "answers": {...}}

    -> {"op": "shutdown"}

Never raises. A helper that dies takes its own feature down, not the router.
"""
import json
import sys
import traceback
import warnings


def emit(payload):
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def main():
    # The typed-decisions checkpoint ships invalid temperatures; Laya warns
    # loudly about this at load. Suppressing the warning is NOT the same as
    # fixing the calibration, so the raw confidence is carried to the caller
    # with a flag saying it is uncalibrated, and the router gates on a
    # threshold fitted on our own eval data instead of trusting it.
    warnings.filterwarnings("ignore", message=".*invalid temperatures.*")

    try:
        from laya import Router
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:200])})
        return

    # max_loaded=3 keeps every checkpoint resident so a question set spanning
    # decision types does not thrash a 1.16B-parameter load between calls.
    router = Router(max_loaded=3)

    # No unsolicited ready line — see the same note in needle_worker.py. A
    # greeting occupies the first reply slot and shifts every real answer.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            emit({"ok": False, "error": "bad request: %s" % exc})
            continue

        op = req.get("op")
        if op == "shutdown":
            return
        if op == "ping":
            emit({"ok": True, "warmed": True})
            continue

        if op == "predict":
            try:
                out = router.predict(
                    req.get("state", ""),
                    req.get("questions") or {},
                    model=req.get("model") or "typed-decisions",
                    max_len=req.get("max_len"),
                )
                emit({"ok": True, "answers": out.get("answers") or {},
                      "uncalibrated": True})
            except Exception as exc:
                emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:300])})
            continue

        emit({"ok": False, "error": "unknown op %r" % op})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"ok": False, "error": "worker crash: %s" % traceback.format_exc()[-300:]})
        sys.exit(1)
