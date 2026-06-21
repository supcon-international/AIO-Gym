"""Parity test: the native numpy port must reproduce the browser JS dynamics.

golden.json holds state-trajectory checkpoints generated from the JS engine
(the source of truth). Here we integrate the Python port with the same fixed
action and assert the state matches at every checkpoint. Any divergence (a bug
in the port) shows up within a few RK4 steps, so matching 8 checkpoints over
200 steps to ~1e-9 proves the two dynamics are identical.

Run directly:  python aiogym/tests/test_parity.py
Or via pytest: pytest aiogym/tests/test_parity.py
"""
from __future__ import annotations
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from aiogym.models import make_model
from aiogym.kernel import Integrator

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden.json")
ATOL = 1e-9
RTOL = 1e-9


def _run(scenario, golden):
    model = make_model(scenario)
    integ = Integrator(model)
    env = {"t_cold": model.p["t_cold"], "t_amb": model.p["t_amb"], "extra_outflow": 0.0}
    act = golden["action"]
    dt = golden["dt"]
    ck = {int(k): v for k, v in golden["checkpoints"].items()}
    last = max(ck)
    worst = 0.0
    for i in range(1, last + 1):
        integ.step(dt, act, env)
        if i in ck:
            ref = ck[i]
            for a, b in zip(integ.x, ref):
                err = abs(a - b)
                tol = ATOL + RTOL * abs(b)
                worst = max(worst, err)
                assert err <= tol, f"{scenario} step {i}: {a!r} vs {b!r} (|Δ|={err:.3e} > {tol:.3e})"
    return worst


def test_parity():
    with open(GOLDEN) as f:
        golden = json.load(f)
    for scenario in ("cascade", "quadruple", "cstr", "hvac"):
        w = _run(scenario, golden[scenario])
        print(f"  {scenario:10s} max|Δ| = {w:.2e}  OK")


if __name__ == "__main__":
    with open(GOLDEN) as f:
        golden = json.load(f)
    print("Parity (native numpy port vs browser JS golden):")
    ok = True
    for scenario in ("cascade", "quadruple", "cstr", "hvac"):
        try:
            w = _run(scenario, golden[scenario])
            print(f"  {scenario:10s} max|Δ| = {w:.2e}  ✓")
        except AssertionError as e:
            ok = False
            print(f"  {scenario:10s} FAIL: {e}")
    print("ALL MATCH ✓" if ok else "PARITY FAILED ✗")
    sys.exit(0 if ok else 1)
