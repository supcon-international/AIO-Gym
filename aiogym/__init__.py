"""aiogym — native (numpy) Gymnasium env over the AIO-Gym plant dynamics.

A fast, synchronous, seedable, vectorizable re-implementation of the browser
AIO-Gym physics (frontend/js/sim), built for RL training (SAC / RLPD / Cal-QL).
Dynamics parity with the browser JS is enforced by tests/test_parity.py.

    import gymnasium as gym, aiogym          # registers the ids on import
    env = gym.make("AIOGym/Cascade-v0")
    # or:  from aiogym import AIOGymNativeEnv;  env = AIOGymNativeEnv("cstr")
"""
from .models import make_model, obs_vector, SCENARIOS
from .kernel import Integrator
from .env import AIOGymNativeEnv

__all__ = ["AIOGymNativeEnv", "make_model", "obs_vector", "Integrator", "SCENARIOS"]

try:
    from gymnasium.envs.registration import register

    _IDS = {"cascade": "Cascade", "quadruple": "Quadruple", "cstr": "CSTR", "hvac": "HVAC"}
    for _scn, _name in _IDS.items():
        register(id=f"AIOGym/{_name}-v0", entry_point="aiogym.env:AIOGymNativeEnv",
                 kwargs={"scenario": _scn})
except Exception:
    # gymnasium not installed yet — the env class is still importable directly
    pass
