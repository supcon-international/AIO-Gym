"""RLPD — Reinforcement Learning with Prior Data (Ball, Smith, Kostrikov, Levine,
ICML 2023), a compact PyTorch implementation.

RLPD is *online* RL that leverages offline data, and is just a strong off-policy
SAC core plus four ingredients — no offline-specific conservatism / behavior
cloning:
  1. critic LayerNorm        — tames value extrapolation on OOD actions (the key)
  2. an ensemble of critics  — random-subset target (REDQ-style) for the bias
  3. symmetric sampling      — every batch is 50% offline data, 50% online data
  4. a high update-to-data ratio (UTD)

Same machinery does offline pretraining (online buffer empty → samples the prior
data) and online learning (keeps the prior data in the mix). Actions live in the
SAC space [-1, 1]; the env uses [0, 1], so we map (a+1)/2 at the boundary and the
exported ONNX policy emits [0, 1] to match the browser RL controller.
"""
from __future__ import annotations
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

LOG_STD_MIN, LOG_STD_MAX = -5.0, 2.0


def mlp(sizes, layernorm=False):
    layers = []
    for i in range(len(sizes) - 1):
        layers.append(nn.Linear(sizes[i], sizes[i + 1]))
        if i < len(sizes) - 2:
            if layernorm:
                layers.append(nn.LayerNorm(sizes[i + 1]))
            layers.append(nn.ReLU())
    return nn.Sequential(*layers)


class Actor(nn.Module):
    def __init__(self, obs_dim, act_dim, hidden=256):
        super().__init__()
        self.net = mlp([obs_dim, hidden, hidden])
        self.mu = nn.Linear(hidden, act_dim)
        self.log_std = nn.Linear(hidden, act_dim)

    def forward(self, obs):
        h = self.net(obs)
        return self.mu(h), self.log_std(h).clamp(LOG_STD_MIN, LOG_STD_MAX)

    def sample(self, obs):
        mu, log_std = self(obs)
        std = log_std.exp()
        dist = torch.distributions.Normal(mu, std)
        u = dist.rsample()
        a = torch.tanh(u)
        # tanh change-of-variables correction
        logp = dist.log_prob(u).sum(-1) - torch.log(1 - a.pow(2) + 1e-6).sum(-1)
        return a, logp

    def act(self, obs, deterministic=False):
        mu, log_std = self(obs)
        if deterministic:
            return torch.tanh(mu)
        std = log_std.exp()
        return torch.tanh(mu + std * torch.randn_like(std))


class Critic(nn.Module):
    """Q(s, a) with LayerNorm — the ingredient that makes online-with-offline-data work."""
    def __init__(self, obs_dim, act_dim, hidden=256):
        super().__init__()
        self.net = mlp([obs_dim + act_dim, hidden, hidden, 1], layernorm=True)

    def forward(self, obs, act):
        return self.net(torch.cat([obs, act], -1)).squeeze(-1)


class ReplayBuffer:
    def __init__(self, obs_dim, act_dim, capacity):
        self.o = np.zeros((capacity, obs_dim), np.float32)
        self.a = np.zeros((capacity, act_dim), np.float32)
        self.r = np.zeros(capacity, np.float32)
        self.o2 = np.zeros((capacity, obs_dim), np.float32)
        self.d = np.zeros(capacity, np.float32)
        self.cap, self.idx, self.size = capacity, 0, 0

    def add(self, o, a, r, o2, d):
        i = self.idx
        self.o[i], self.a[i], self.r[i], self.o2[i], self.d[i] = o, a, r, o2, d
        self.idx = (i + 1) % self.cap
        self.size = min(self.size + 1, self.cap)

    def sample(self, n, device):
        idx = np.random.randint(0, self.size, n)
        t = lambda x: torch.as_tensor(x[idx], device=device)
        return t(self.o), t(self.a), t(self.r), t(self.o2), t(self.d)


class RLPD:
    def __init__(self, obs_dim, act_dim, hidden=256, n_critics=5, subset=2, utd=5,
                 gamma=0.99, tau=0.005, lr=3e-4, batch=256, device="cpu"):
        self.device = torch.device(device)
        self.obs_dim, self.act_dim = obs_dim, act_dim
        self.gamma, self.tau, self.batch = gamma, tau, batch
        self.n_critics, self.subset, self.utd = n_critics, subset, utd

        self.actor = Actor(obs_dim, act_dim, hidden).to(self.device)
        self.critics = nn.ModuleList([Critic(obs_dim, act_dim, hidden) for _ in range(n_critics)]).to(self.device)
        self.targets = nn.ModuleList([Critic(obs_dim, act_dim, hidden) for _ in range(n_critics)]).to(self.device)
        self.targets.load_state_dict(self.critics.state_dict())

        self.a_opt = torch.optim.Adam(self.actor.parameters(), lr=lr)
        self.c_opt = torch.optim.Adam(self.critics.parameters(), lr=lr)
        self.log_alpha = torch.tensor(np.log(0.1), device=self.device, requires_grad=True)
        self.al_opt = torch.optim.Adam([self.log_alpha], lr=lr)
        self.target_entropy = -float(act_dim)

        self.online = ReplayBuffer(obs_dim, act_dim, 1_000_000)
        self.offline = None

    # actions: env uses [0,1], SAC uses [-1,1]
    @staticmethod
    def to_env(a):
        return (a + 1.0) * 0.5

    @staticmethod
    def to_sac(a01):
        return a01 * 2.0 - 1.0

    def load_offline(self, transitions):
        """transitions: list of (obs, act01, reward, next_obs, done)."""
        buf = ReplayBuffer(self.obs_dim, self.act_dim, max(len(transitions), 1))
        for o, a01, r, o2, d in transitions:
            buf.add(np.asarray(o, np.float32), self.to_sac(np.asarray(a01, np.float32)), r,
                    np.asarray(o2, np.float32), float(d))
        self.offline = buf

    def push(self, o, a01, r, o2, d):
        self.online.add(np.asarray(o, np.float32), self.to_sac(np.asarray(a01, np.float32)), r,
                        np.asarray(o2, np.float32), float(d))

    @torch.no_grad()
    def act(self, obs, deterministic=False):
        o = torch.as_tensor(np.asarray(obs, np.float32), device=self.device).unsqueeze(0)
        a = self.actor.act(o, deterministic).squeeze(0).cpu().numpy()
        return np.clip(self.to_env(a), 0.0, 1.0)

    def _sample(self):
        # symmetric sampling: half offline, half online (RLPD ingredient 3)
        if self.offline is not None and self.offline.size > 0 and self.online.size > 0:
            h = self.batch // 2
            a = self.offline.sample(h, self.device)
            b = self.online.sample(self.batch - h, self.device)
            return tuple(torch.cat([x, y], 0) for x, y in zip(a, b))
        src = self.online if (self.offline is None or self.online.size > 0) else self.offline
        return src.sample(self.batch, self.device)

    def update(self):
        alpha = self.log_alpha.exp().detach()
        for _ in range(self.utd):
            o, a, r, o2, d = self._sample()
            with torch.no_grad():
                a2, logp2 = self.actor.sample(o2)
                pick = np.random.choice(self.n_critics, self.subset, replace=False)
                q_next = torch.stack([self.targets[i](o2, a2) for i in pick], 0).min(0).values
                y = r + self.gamma * (1 - d) * (q_next - alpha * logp2)
            q_loss = sum(F.mse_loss(c(o, a), y) for c in self.critics)
            self.c_opt.zero_grad(set_to_none=True)
            q_loss.backward()
            self.c_opt.step()

        # actor + temperature (once per env step, on a fresh batch)
        o = self._sample()[0]
        ap, logp = self.actor.sample(o)
        q_pi = torch.stack([c(o, ap) for c in self.critics], 0).mean(0)
        a_loss = (alpha * logp - q_pi).mean()
        self.a_opt.zero_grad(set_to_none=True)
        a_loss.backward()
        self.a_opt.step()

        al_loss = -(self.log_alpha.exp() * (logp.detach() + self.target_entropy)).mean()
        self.al_opt.zero_grad(set_to_none=True)
        al_loss.backward()
        self.al_opt.step()

        with torch.no_grad():
            for c, tc in zip(self.critics.parameters(), self.targets.parameters()):
                tc.mul_(1 - self.tau).add_(self.tau * c)
        return {"q_loss": float(q_loss.detach()), "a_loss": float(a_loss.detach()), "alpha": float(alpha)}

    # ---- persistence ----
    def save_onnx(self, path):
        """Export a deterministic obs -> action[0,1] policy for the browser RL controller."""
        class Det(nn.Module):
            def __init__(self, actor):
                super().__init__()
                self.actor = actor

            def forward(self, obs):
                mu, _ = self.actor(obs)
                return (torch.tanh(mu) + 1.0) * 0.5

        m = Det(self.actor).eval()
        with torch.no_grad():
            torch.onnx.export(m, torch.zeros(1, self.obs_dim), path,
                              input_names=["obs"], output_names=["action"],
                              dynamic_axes={"obs": {0: "batch"}, "action": {0: "batch"}}, opset_version=17)

    def state_dict(self):
        return {"actor": self.actor.state_dict(), "critics": self.critics.state_dict(),
                "targets": self.targets.state_dict(), "log_alpha": self.log_alpha.detach()}

    def load_state_dict(self, sd):
        self.actor.load_state_dict(sd["actor"])
        self.critics.load_state_dict(sd["critics"])
        self.targets.load_state_dict(sd["targets"])
        with torch.no_grad():
            self.log_alpha.copy_(sd["log_alpha"])
