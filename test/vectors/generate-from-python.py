#!/usr/bin/env python3
"""Generate the cross-language hash vectors FROM THE PYTHON KERNEL.

The TypeScript test asserts against this file's output. That only means
something if the expectations come from the other implementation rather than
from us — hand-written vectors would prove the TS code agrees with itself.

Works two ways, so CI and a laptop produce identical output:
  * `pip install once-kernel` (what CI does), or
  * a local checkout at ~/Desktop/once/src (what the author does).

Usage:  python generate-from-python.py > python-jcs-vectors.json
"""
import json
import os
import sys

try:
    from once.canonical import payload_hash_hex
except ModuleNotFoundError:
    local = os.path.expanduser("~/Desktop/once/src")
    if not os.path.isdir(local):
        sys.exit(
            "once-kernel not importable and no local checkout at "
            f"{local}. Run: pip install once-kernel"
        )
    sys.path.insert(0, local)
    from once.canonical import payload_hash_hex

# Chosen to cover the places JCS implementations actually diverge: key
# ordering, unicode, escaping, negative zero, exponent formatting at both
# ends of the range, empty containers, and deep nesting.
CASES = [
    {"b": 1, "a": 2},
    {"z": [3, 2, 1], "a": {"n": None, "t": True}},
    [1, 2.5, -0.0, 1e21, 1e-7],
    "hello é 中文 😀",
    {"k": 'va"l\\ue\n\t'},
    {},
    [],
    0,
    -1,
    True,
    None,
    {"nested": {"deep": {"deeper": [{"x": 1}, {"y": [1, 2, {"z": 3}]}]}}},
    {"é": 1, "e": 2, "E": 3, "1": 4},
    0.1,
    [[[[1]]]],
]

if __name__ == "__main__":
    print(
        json.dumps(
            [{"payload": c, "hash": payload_hash_hex(c)} for c in CASES],
            ensure_ascii=False,
        )
    )
