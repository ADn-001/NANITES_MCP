"""
Needle 3 bridge.

A separate FILE rather than an inline `python -c` string, because the schema
generator needs real newlines and real triple-quotes, and escaping those
through a TypeScript template literal is a reliable way to ship a silently
broken program.

Reads one JSON object on stdin, writes one JSON object on stdout, and NEVER
raises: a helper that crashes must degrade to "unavailable", not take a request
down with it.

  {"op": "warm"}
  {"op": "embed",  "text": "..."}
  {"op": "extract","text": "...", "schema": {"city": "str", "temp_c": "float"}}
"""
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, default=str))
    sys.stdout.flush()


def build_schema(fields):
    """
    Build a dataclass by EXECUTING generated source.

    Not a stylistic choice. A dataclass made with make_dataclass has no field
    docstrings, and Needle reads those docstrings as the field descriptions —
    probed, a dynamic dataclass returns None where a declared one extracts
    correctly.

    The type names are the SOURCE SPELLINGS. Emitting a builtin object's
    __name__ here produces the string "str" in an annotation position, which is
    not a type and yields an unparseable schema.
    """
    srcnames = {"str": "str", "float": "float", "int": "int", "bool": "bool"}
    lines = [
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class Extracted:",
        '    """Structured fields extracted from the text."""',
    ]
    for i, (name, kind) in enumerate(fields.items()):
        if i:
            lines.append("")
        lines.append("    %s: %s" % (name, srcnames.get(kind, "str")))
        lines.append('    """the %s"""' % name.replace("_", " "))
    source = "\n".join(lines)
    namespace = {}
    exec(compile(source, "<nanites-schema>", "exec"), namespace)
    return namespace["Extracted"]


def main():
    try:
        from needle import Needle
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:200])})
        return

    try:
        op = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        emit({"ok": False, "error": "bad input: %s" % exc})
        return

    try:
        if op.get("op") == "warm":
            Needle()
            emit({"ok": True, "warmed": True})
            return

        engine = Needle()
        if op.get("op") == "embed":
            emit({"ok": True, "vector": engine.embed(op.get("text", ""))})
        elif op.get("op") == "extract":
            schema = build_schema(op.get("schema") or {})
            emit({"ok": True, "value": engine.extract(op.get("text", ""), schema=schema)})
        else:
            emit({"ok": False, "error": "unknown op %r" % op.get("op")})
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:200])})


if __name__ == "__main__":
    main()
