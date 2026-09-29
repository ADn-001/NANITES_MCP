"""Phase 1 probe: can Needle's complete() recover mangled tool calls?

Two lessons encoded here, both learned by running this probe wrong first:

  1. Needle reports the tool name it was GIVEN. Handing it dataclasses makes
     it emit the Python class name (`ReadFile`), not the wire name
     (`read_file`). The router's contract is a wire name, so the tools must be
     real functions decorated with @needle.tool.

  2. Hallucination and abstention have to be measured against a tool set that
     actually excludes the requested name, or every case trivially routes to
     the nearest available tool.

Side-effect-free by construction: complete() returns the call and does not
execute it, so no case below can touch the filesystem.
"""
import needle
from needle import Needle


@needle.tool
def read_file(path: str):
    """Read the contents of a file at an absolute path."""
    raise AssertionError("MUST NOT BE EXECUTED BY complete()")


@needle.tool
def search_files(pattern: str, path: str):
    """Search for files matching a glob pattern inside a directory."""
    raise AssertionError("MUST NOT BE EXECUTED BY complete()")


@needle.tool
def list_directory(path: str):
    """List the entries of a directory."""
    raise AssertionError("MUST NOT BE EXECUTED BY complete()")


CASES = [
    ("call search_files with pattern src/**/*.ts and path /repo",
     "search_files", {"pattern": "src/**/*.ts", "path": "/repo"}),
    ("I need to read the file at /etc/hosts",
     "read_file", {"path": "/etc/hosts"}),
    ('{"name": "read_file", "arguments": {"path": "/tmp/a.txt"',          # truncated
     "read_file", {"path": "/tmp/a.txt"}),
    ("Please use read_file. The path is /var/log/syslog.",                 # prose
     "read_file", {"path": "/var/log/syslog"}),
    ('search_files(pattern="*.json", path="/data"',                         # truncated
     "search_files", {"pattern": "*.json", "path": "/data"}),
    ("read the file C:\\Users\\me\\notes.md",
     "read_file", {"path": "C:\\Users\\me\\notes.md"}),
    ("First search_files for '*.py' under /opt, then read_file on /opt/a.py",
     "search_files", {"pattern": "*.py", "path": "/opt"}),
    ("read_file with path=/tmp/b.bin please",                              # kwargs
     "read_file", {"path": "/tmp/b.bin"}),
    ('{"name": "read_file", "arguments": "/tmp/c.txt"}',                   # string args
     "read_file", {"path": "/tmp/c.txt"}),
    ("list the /tmp directory",                                            # third tool
     "list_directory", {"path": "/tmp"}),
    # A tool that is NOT in the set: it must abstain, not substitute.
    ("HALLUCINATION: open_file with path /tmp/x", None, {}),
    # Nothing applies at all.
    ("hello there, how are you?", None, {}),
]


def main() -> None:
    # stateless=True. The default keeps one conversation, so query N+1 is
    # scored against a transcript of queries 1..N — which showed up as
    # `/tmp/a.txt` turning into `*.b.bin` three cases later, and as the two
    # "nothing applies" cases hallucinating a call. Every turn here is an
    # INDEPENDENT request (a real router serves concurrent callers), so
    # cross-turn bleed is a bug, not a feature.
    engine = Needle(tools=[read_file, search_files, list_directory], stateless=True)
    ok = wrong = abstained = hallucinated = 0
    for text, want_tool, want_args in CASES:
        r = engine.complete(text)
        calls = r.get("function_calls") or []
        conf = r.get("confidence")
        if want_tool is None:
            if not calls:
                abstained += 1
                print("ABSTAIN    conf=%.4f  %r" % (conf, text[:48]))
            else:
                hallucinated += 1
                print("HALLUC     conf=%.4f  %r -> %s%s"
                      % (conf, text[:48], calls[0]["name"], calls[0]["arguments"]))
            continue
        if not calls:
            wrong += 1
            print("MISS       conf=%.4f  %r (wanted %s)" % (conf, text[:48], want_tool))
            continue
        got = calls[0]
        if got["name"] == want_tool and got["arguments"] == want_args:
            ok += 1
            print("OK         conf=%.4f  %s%s" % (conf, got["name"], got["arguments"]))
        else:
            wrong += 1
            print("WRONG      conf=%.4f  %r\n             want %s%s\n             got  %s%s"
                  % (conf, text[:48], want_tool, want_args,
                     got["name"], got["arguments"]))
    print()
    print("correct=%d wrong=%d abstained=%d hallucinated=%d of %d"
          % (ok, wrong, abstained, hallucinated, len(CASES)))


if __name__ == "__main__":
    main()
