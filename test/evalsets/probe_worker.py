"""Phase 1b, corrected: what the persistent-worker design needs to know.

Three questions, all of which change the architecture:
  1. Does extract() expose a confidence? (It does not — only complete() does,
     which is why the repair rung must be built on complete().)
  2. What is cold vs warm latency? A per-request spawn is only affordable if
     this is small.
  3. Does one engine survive MANY DYNAMIC schemas? Repair builds a dataclass
     per tool, so an engine that can only hold the schema it was born with is
     useless there.

`extract` raises ExtractionValidationError on a value not grounded in the
input. That is a FEATURE for the router: a repaired tool call whose path never
appeared in the model's output is exactly the hallucination we must not
forward. Caught here rather than in a try/except so the behaviour is recorded.
"""
import time
from dataclasses import dataclass

from needle import Needle, ExtractionValidationError


@dataclass
class OrderA:
    """An order extracted from prose."""
    order_id: int
    """the numeric order id"""
    city: str
    """the shipping city"""
    total: float
    """the order total in EUR"""


@dataclass
class ReadFileArgs:
    """Arguments for reading a file."""
    path: str
    """the absolute path of the file to read"""


@dataclass
class RunCmdArgs:
    """Arguments for running a shell command."""
    command: str
    """the command line to run"""
    timeout_s: int
    """how long to allow it to run"""


def timed(fn, *a, **kw):
    t0 = time.time()
    try:
        return fn(*a, **kw), time.time() - t0, None
    except ExtractionValidationError as e:
        return None, time.time() - t0, "UNGROUNDED: %s" % str(e)[:60]


def main():
    t0 = time.time()
    engine = Needle(stateless=True)
    print("cold construct:         %.2fs" % (time.time() - t0))

    text = "Order 8812 for 3 widgets, 249.50 EUR, shipping to Berlin."

    r, dt, err = timed(engine.extract, text, schema=OrderA)
    print("extract #1 (OrderA):    %.3fs -> %r %s" % (dt, r, err or ""))
    print("  return type: %s" % type(r).__name__)
    for attr in ("confidence", "score", "logprob"):
        print("  hasattr(result, %r) = %s" % (attr, hasattr(r, attr)))

    r, dt, _ = timed(engine.extract, text, schema=OrderA)
    print("extract #2 (same):      %.3fs" % dt)

    # Q3: different schemas on the SAME engine.
    r, dt, err = timed(engine.extract, "open /etc/hosts and show me", schema=ReadFileArgs)
    print("\nextract (ReadFileArgs): %.3fs -> %r %s" % (dt, r, err or ""))
    r, dt, err = timed(engine.extract, "run npm test with a 30 second timeout", schema=RunCmdArgs)
    print("extract (RunCmdArgs):   %.3fs -> %r %s" % (dt, r, err or ""))
    r, dt, err = timed(engine.extract, text, schema=OrderA)
    print("extract (OrderA again): %.3fs -> %r %s" % (dt, r, err or ""))

    times = []
    for _ in range(12):
        _, dt, _ = timed(engine.extract, text, schema=OrderA)
        times.append(dt)
    times.sort()
    print("\nextract latency x12:    p50=%.3fs p95=%.3fs" % (times[6], times[11]))

    t0 = time.time()
    v = engine.embed("hello")
    print("embed:                  %.3fs dim=%d" % (time.time() - t0, len(v)))

    # complete() latency, which is what the REPAIR rung actually calls, plus
    # the confidence it is gated on.
    times, confs = [], []
    for q in ["read_file with path=/tmp/a.txt", "search_files pattern=*.py path=/opt",
              "list the /tmp directory"]:
        t0 = time.time()
        out = engine.complete(q)
        times.append(time.time() - t0)
        confs.append(out.get("confidence"))
    times.sort()
    print("complete() latency:     p50=%.3fs  confidences=%s" % (times[1], confs))

    # One engine, many DIFFERENT tools, repeatedly — the pruning/shim case.
    import needle

    def mk(n, p):
        def f(path: str):
            """%s""" % p
            raise AssertionError("never executed")
        f.__name__ = n
        return needle.tool(f)

    tools = [mk("read_file", "Read a file at a path."),
             mk("write_file", "Write content to a file."),
             mk("search_files", "Search for files by glob."),
             mk("run_command", "Run a shell command.")]
    eng2 = Needle(tools=tools, stateless=True)
    qs = ["read_file with path=/a", "write_file to /b", "search_files *.py in /c",
          "run_command npm test"]
    t0 = time.time()
    outs = [eng2.complete(q) for q in qs]
    print("\n4 tools, 4 calls:      %.3fs total" % (time.time() - t0))
    for q, o in zip(qs, outs):
        fc = (o.get("function_calls") or [{}])[0]
        print("  %-34s -> %-14s conf=%.3f %s"
              % (q[:34], fc.get("name"), o.get("confidence", 0), fc.get("arguments")))


if __name__ == "__main__":
    main()
