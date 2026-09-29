"""Why the repair rung uses complete(), not extract().

Measured: extract() has NO confidence field and takes ~1.9s warm. complete()
returns a calibrated confidence in ~0.08s. So the repair rung is built on
complete().

This probe pins down the ONE thing that decides whether that works: tool
DESCRIPTIONS carry the argument semantics. A previous draft used one-line
descriptions and Needle returned a `path` argument for a `pattern` parameter
at confidence 0.224 — wrong shape, high enough confidence to be dangerous.
Real descriptions, same engine, same queries.
"""
import time

import needle
from needle import Needle


def mk(name, doc, params=("path",)):
    """A tool stub whose body must never run."""
    if params == ("path",):
        def f(path: str):
            """%s""" % doc
            raise AssertionError("never executed")
    else:
        def f(pattern: str, path: str):
            """%s""" % doc
            raise AssertionError("never executed")
    f.__name__ = name
    return needle.tool(f)


CASES = [
    # (tools in the set, query, expected tool, expected args)
    (["read_file"], "read_file with path=/etc/hosts",
     "read_file", {"path": "/etc/hosts"}),
    (["read_file", "write_file"], "write_file to /tmp/out.txt",
     "write_file", {"path": "/tmp/out.txt"}),
    (["search_files"], "search_files pattern=*.py path=/opt",
     "search_files", {"pattern": "*.py", "path": "/opt"}),
    (["run_command"], "run_command npm test",
     "run_command", {"path": "npm test"}),
    # A malformed call the deterministic ladder already failed on.
    (["read_file"], '{"name": "read_file", "arguments": {"path": "/tmp/a.txt"',
     "read_file", {"path": "/tmp/a.txt"}),
    (["read_file"], '{"name":"read_file","arguments":"/tmp/c.txt"}',
     "read_file", {"path": "/tmp/c.txt"}),
    (["read_file"], "Please use read_file. The path is /var/log/syslog.",
     "read_file", {"path": "/var/log/syslog"}),
    # Not a tool call at all — must abstain, not guess.
    (["read_file"], "hello there, how are you?", None, {}),
]

TOOL_DOCS = {
    "read_file": "Read the contents of a file at an absolute path and return its text.",
    "write_file": "Write text content to a file, creating the file if it does not exist.",
    "search_files": "Search for files matching a glob pattern inside a directory.",
    "run_command": "Run a shell command and return stdout, stderr and the exit code.",
}


def main():
    ok = miss = abstain_wrong = 0
    lat = []
    for names, query, want_tool, want_args in CASES:
        tools = []
        for n in names:
            tools.append(mk(n, TOOL_DOCS[n], ("pattern", "path") if n == "search_files" else ("path",)))
        engine = Needle(tools=tools, stateless=True)
        t0 = time.time()
        out = engine.complete(query)
        lat.append(time.time() - t0)
        calls = out.get("function_calls") or []
        conf = out.get("confidence", 0.0)
        if want_tool is None:
            good = not calls
            abstain_wrong += 0 if good else 1
            print("%-6s conf=%.3f  abstain-expected -> %s"
                  % ("OK" if good else "HALLUC", conf,
                     calls[0]["name"] if calls else "(empty list)"))
            continue
        if not calls:
            miss += 1
            print("MISS   conf=%.3f  %r" % (conf, query[:44]))
            continue
        got = calls[0]
        # Argument-key equality is what matters; a correct name with the wrong
        # parameter names is a broken call, not a repair.
        good = got["name"] == want_tool and got["arguments"] == want_args
        ok += good
        miss += (not good)
        print("%-6s conf=%.3f  %s%s" % ("OK" if good else "WRONG", conf,
                                        got["name"], got["arguments"]))
    lat.sort()
    print()
    print("correct=%d wrong=%d of %d" % (ok, miss, len(CASES)))
    print("complete() latency: p50=%.3fs p95=%.3fs" % (lat[len(lat)//2], lat[-1]))


if __name__ == "__main__":
    main()
