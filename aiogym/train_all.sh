#!/bin/bash
# Reproduce the 4 shipped ECONOMIC RLPD policies in parallel (18-core box -> 4
# threads each). Economic objective = value − energy-cost within soft acceptance
# bands, under 工况 (operating-regime) variation; the optimum drifts so fixed-SP
# PID / fixed-model MPC are structurally suboptimal and the adaptive RL wins.
# --bc-steps 0 because BC-to-PID is a bad init when the optimum is far from the SP.
# Outputs aiogym/runs/rlpd_<scn>_econ.{pt,onnx,json}; copy the .onnx to
# frontend/models/rlpd_<scn>.onnx for the browser.
cd "$(dirname "$0")/.."

run() {
  local scn=$1 steps=$2 online=$3
  OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 python3 -u aiogym/train_rlpd.py \
    --scenario "$scn" --reward-mode economic --episode-steps "$steps" \
    --offline-episodes 30 --bc-steps 0 --pretrain-updates 4000 --online-steps "$online" \
    --eval-every 2500 --out "aiogym/runs/rlpd_${scn}_econ" > "/tmp/${scn}_econ.log" 2>&1
}

run cstr      400 25000 &
run cascade   600 25000 &
run quadruple 600 25000 &
run hvac      600 25000 &
wait
echo "ALL ECONOMIC TRAINING DONE"
for s in cstr cascade quadruple hvac; do echo "--- $s ---"; tail -2 "/tmp/${s}_econ.log"; done
