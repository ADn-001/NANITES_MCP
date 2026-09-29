"""
Needle worker: a LONG-LIVED process, one JSON object per line on stdin/stdout.

Why a worker and not a per-request `python needle_bridge.py`:

  - Cold construct is 0.13s but the first `extract` costs ~1.4s, and measured
    warm `complete()` is still ~0.1-0.9s depending on the schema. Spawning a
    fresh interpreter for every request pays the construct plus a fresh model
    load EVERY time, which makes a per-call feature too slow to keep on.
  - The model is loaded once here and reused for the process lifetime.

Protocol, one JSON object per line:

    -> {"op": "ping"}
    <- {"ok": true, "warmed": true}

    -> {"op": "complete", "tools": [...], "query": "read_file path=/a",
        "tool_source": "<source>"}
    <- {"ok": true, "confidence": 0.81, "calls": [{"name":..., "arguments":{}}]}

    -> {"op": "extract", "schema": {...}, "text": "...", "schema_source": "..."}
    <- {"ok": true, "value": {...}}   |   {"ok": false, "error": "..."}

`tool_source` / `schema_source` carry PYTHON SOURCE, built by the caller,
because building a tool or a dataclass from live data needs real newlines and
real triple-quotes — exactly the escaping problem that made the original
inline-template version a silently broken program.

The worker NEVER raises and NEVER exits on a bad request: a helper that dies
takes the router's feature with it, and a dead feature is better than a dead
process. `op: "shutdown"` is the only way out.
"""
import json
import sys
import traceback


def emit(payload):
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def build_namespace(source):
    """Execute generated source in a fresh namespace and return it."""
    namespace = {}
    exec(compile(source, "<nanites-worker>", "exec"), namespace)
    return namespace


def main():
    try:
        from needle import Needle, ExtractionValidationError
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:200])})
        return

    # stateless=True is MANDATORY, not a tuning choice. The default keeps one
    # conversation, so call N+1 is scored against the transcript of calls 1..N.
    # Measured on a 12-case repair set: default 0/12 correct with two
    # hallucinations, stateless 10/10 with two correct abstentions. A router
    # serves concurrent unrelated callers, so that bleed is a defect.
    engine = Needle(stateless=True)
    # Cache keyed on the generated source: a repair call carries the same tool
    # definitions for a burst of calls, and rebuilding the prefix per request
    # is the expensive part.
    tool_cache = {}

    # NO unsolicited ready line here.
    #
    # An unprompted {"warmed": true} on startup occupies the first slot of a
    # line protocol, so a client that sent its real request immediately gets
    # the handshake back as that request's reply and every later answer is
    # shifted by one. Measured: 6 calls, 6 replies, each one the PREVIOUS
    # call's answer — including a confident, wrong result for a request that
    # was not a tool call at all.
    #
    # Readiness is a REQUEST ("ping"), not a greeting. The client asks, and
    # nothing is in flight when it asks.
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

        try:
            if op == "complete":
                source = req.get("tool_source") or ""
                if source not in tool_cache:
                    ns = build_namespace(source)
                    tool_cache.clear()  # one tool set resident at a time
                    tool_cache[source] = ns.get("TOOLS") or []
                tools = tool_cache[source]
                if not tools:
                    # A tool set that failed to build must not silently look
                    # like an empty catalogue, which would make every query
                    # abstain and look like a model failure.
                    emit({"ok": False, "error": "tool_source produced no TOOLS"})
                    continue
                scoped = Needle(tools=tools, stateless=True)
                out = scoped.complete(req.get("query", ""))
                calls = []
                for c in (out.get("function_calls") or []):
                    calls.append({
                        "name": c.get("name"),
                        "arguments": c.get("arguments") or {},
                    })
                emit({
                    "ok": True,
                    "confidence": out.get("confidence"),
                    "calls": calls,
                    "reasoning": (out.get("reasoning") or "")[:400],
                })

            elif op == "extract":
                source = req.get("schema_source") or ""
                ns = build_namespace(source)
                schema = ns.get("SCHEMA")
                if schema is None:
                    emit({"ok": False, "error": "schema_source produced no SCHEMA"})
                    continue
                value = engine.extract(req.get("text", ""), schema=schema)
                emit({"ok": True, "value": value})

            elif op == "embed":
                emit({"ok": True, "vector": engine.embed(req.get("text", ""))})

            else:
                emit({"ok": False, "error": "unknown op %r" % op})

        except ExtractionValidationError as exc:
            # A value not grounded in the input. Deliberately DISTINCT from a
            # generic failure: for a repair rung this is the signal that the
            # model invented an argument, and the caller must not forward it.
            emit({"ok": False, "ungrounded": True, "error": str(exc)[:300]})
        except Exception as exc:
            emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:300])})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A worker that dies leaves the router with a broken pipe rather than a
        # clear reason, so report once and exit.
        emit({"ok": False, "error": "worker crash: %s" % traceback.format_exc()[-300:]})
        sys.exit(1)
