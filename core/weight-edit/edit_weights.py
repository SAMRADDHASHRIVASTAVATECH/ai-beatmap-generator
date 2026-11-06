#!/usr/bin/env python
"""Direct weight editing, no gradients, no optimizer.

Local implementation of the *loop* described in "Sparks of Weight-Space
Programming" (Takehi, Teoh, Zhang, Khattab - MIT CSAIL, 2 Nov 2026, blog post,
not peer-reviewed): locate the weights responsible for a failure by measuring
ablations, edit a tiny sparse set of them, then re-measure on held-out data.

Honest scope note. The paper's "weights only, no tools" claim held on networks
of ~17k-172k weights; every experiment on a real language model used Python and
batches of practice problems (Honnibal's critique, 3 Nov 2026). This script is
the second thing: a measurement loop, not a magic reader.

Modes
  synthetic  A small MLP is deliberately crippled at init (weights scaled down so
             it collapses to one class). The loop then repairs it by direct
             sparse edits. Runs on CPU in seconds and produces real numbers.
  hf         A local HuggingFace causal-LM directory. Measures repetition loops,
             scans layers by causal ablation, damps the top singular direction
             in the worst layers with a thresholded (sparse) edit.

Nothing is ever written into the base model. Output is a delta file plus
metrics.json inside the experiment directory.

Config path is passed with --config; the final line of stdout is
  RESULT {json}
so the Node side can parse it. All progress goes to stderr.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def fail(msg, code=3):
    print(json.dumps({"ok": False, "error": msg}), flush=True)
    sys.exit(code)

def load_torch():
    try:
        import torch  # noqa: F401
        return torch
    except Exception as e:  # pragma: no cover - environment dependent
        fail(f"torch is not importable in this Python: {e}")

# ------------------------------------------------------------------ synthetic
def make_blobs(torch, n, dim, classes, noise, seed, centers=None, shift=0.0):
    g = torch.Generator().manual_seed(seed)
    if centers is None:
        cgen = torch.Generator().manual_seed(424242)
        centers = torch.randn(classes, dim, generator=cgen) * 3.0
    y = torch.randint(0, classes, (n,), generator=g)
    x = centers[y] + torch.randn(n, dim, generator=g) * noise + shift
    return x, y, centers

def build_mlp(torch, dim, hidden, classes, scale):
    # Deliberately pathological init: the small `scale` collapses logits to ~0,
    # so the untrained net predicts one class and scores ~1/classes.
    g = torch.Generator().manual_seed(7)
    def mat(a, b):
        return (torch.randn(a, b, generator=g) * scale).requires_grad_(False)
    return [
        ("fc1.weight", mat(hidden, dim)), ("fc1.bias", torch.zeros(hidden)),
        ("fc2.weight", mat(classes, hidden)), ("fc2.bias", torch.zeros(classes)),
    ]

def forward_mlp(params, x):
    import torch
    p = dict(params)
    h = torch.relu(x @ p["fc1.weight"].T + p["fc1.bias"])
    return h @ p["fc2.weight"].T + p["fc2.bias"]

def accuracy(params, x, y):
    import torch
    with torch.no_grad():
        pred = forward_mlp(params, x).argmax(dim=1)
    return float((pred == y).float().mean().item())

def clone_params(params):
    out = []
    for name, t in params:
        c = t.clone()
        out.append((name, c))
    return out

def run_synthetic(torch, cfg):
    """Repair a small net whose output channel is stuck.

    The base net is fitted once by ridge regression (closed form, not gradient
    descent) so there is a competent policy to damage. One output bias is then
    driven to a huge value, which saturates the argmax and collapses accuracy to
    chance. The loop must find that single offending parameter by measurement
    and edit it, with the correction verified on a held-out split.
    """
    dim = int(cfg.get("dim", 64))
    hidden = int(cfg.get("hidden", 64))
    classes = int(cfg.get("classes", 6))
    noise = float(cfg.get("noise", 1.0))
    seed = int(cfg.get("seed", 1234))
    budget = int(cfg.get("budget_evals", 240))

    xtr, ytr, centers = make_blobs(torch, 4000, dim, classes, noise, seed)
    xva, yva, _ = make_blobs(torch, 1200, dim, classes, noise, seed + 1, centers)
    xte, yte, _ = make_blobs(torch, 1200, dim, classes, noise, seed + 2, centers, shift=0.15)

    g = torch.Generator().manual_seed(seed + 9)
    w1 = torch.randn(hidden, dim, generator=g) / max(1.0, dim ** 0.5)
    htr = torch.relu(xtr @ w1.T)
    # ridge readout: W2 = (H^T H + lambda I)^-1 H^T Y
    Y = torch.nn.functional.one_hot(ytr, classes).float()
    lam = 1.0
    A = htr.T @ htr + lam * torch.eye(hidden)
    w2 = torch.linalg.solve(A, htr.T @ Y).T
    b2 = torch.zeros(classes)

    params = [("fc1.weight", w1), ("fc1.bias", torch.zeros(hidden)), ("fc2.weight", w2), ("fc2.bias", b2)]
    total_params = sum(t.numel() for _, t in params)

    clean_val = accuracy(params, xva, yva)
    log(f"base policy val={clean_val:.3f} before damage")

    # Damage: one output channel saturates, so every argmax picks class 0.
    with torch.no_grad():
        b2[0] = 30.0
    params = clone_params(params)

    before = {
        "train": accuracy(params, xtr, ytr),
        "val": accuracy(params, xva, yva),
        "test": accuracy(params, xte, yte),
    }
    log(f"after damage val={before['val']:.3f} test={before['test']:.3f} "
        f"({total_params} params, chance={1.0/classes:.3f})")

    # ---- attribution by measurement: zero one parameter at a time, keep the
    # ones whose removal recovers accuracy. No gradient is computed anywhere.
    probe_idx = []
    for name, t in params:
        flat = t.reshape(-1)
        order = torch.argsort(flat.abs(), descending=True)[:min(24, flat.numel())]
        for idx in order.tolist():
            probe_idx.append((name, idx))
    probe_idx = probe_idx[:budget]

    scored = []
    for name, idx in probe_idx:
        p = dict(params)
        saved = p[name].reshape(-1)[idx].clone()
        with torch.no_grad():
            p[name].reshape(-1)[idx] = 0
        v = accuracy(p, xva, yva)
        with torch.no_grad():
            p[name].reshape(-1)[idx] = saved
        if v > before["val"] + 1e-4:
            scored.append({"tensor": name, "index": idx, "val_if_zeroed": round(v, 4)})
    scored.sort(key=lambda r: r["val_if_zeroed"], reverse=True)
    attribution = scored[:6]
    log(f"recovery candidates: {json.dumps(attribution)}")

    # ---- sparse hill-climb: apply the single best correction, re-measure,
    # repeat while it still helps. Bounded by budget_evals.
    current = clone_params(params)
    cur_val = before["val"]
    edits = []
    evaluated = len(probe_idx)
    rounds = 0
    while evaluated < budget and rounds < 6:
        best = None
        for name, idx in probe_idx:
            p = clone_params(current)
            t = dict(p)[name].reshape(-1)
            saved = t[idx].clone()
            with torch.no_grad():
                t[idx] = 0
            v = accuracy(p, xva, yva)
            evaluated += 1
            if v > cur_val + 1e-4 and (best is None or v > best["val"]):
                best = {"name": name, "idx": idx, "val": v, "saved": float(saved), "params": p}
            if evaluated >= budget:
                break
        if not best:
            break
        current = best["params"]
        cur_val = best["val"]
        edits.append({"tensor": best["name"], "index": best["idx"], "old": round(best["saved"], 4), "new": 0.0})
        rounds += 1

    after = {
        "train": accuracy(current, xtr, ytr),
        "val": cur_val,
        "test": accuracy(current, xte, yte),
    }

    delta = {}
    base = dict(params)
    for name, t in current:
        d = t - base[name]
        if d.abs().sum() > 0:
            delta[name] = d.clone()

    result = {
        "ok": after["test"] > before["test"] + 0.05,
        "mode": "synthetic",
        "before": before,
        "after": after,
        "clean_val_before_damage": round(clean_val, 4),
        "chance": round(1.0 / classes, 4),
        "attribution": attribution,
        "edits": edits,
        "params_total": total_params,
        "params_touched": len(edits),
        "fraction_touched": round(len(edits) / total_params, 8),
        "evaluations": evaluated,
        "honest_notes": [
            "the obstacle is one saturated output bias, chosen because it is sparse and verifiable",
            "this demonstrates the measure -> locate -> edit -> verify loop, not transformer surgery",
            "no gradient or optimizer is used; base tensors are untouched",
        ],
    }

    out = os.path.join(cfg["_dir"], "delta.pt")
    torch.save({"delta": delta, "meta": result}, out)
    result["delta_file"] = out
    return result

# ------------------------------------------------------------------------ hf
def repetition_metrics(torch, ids):
    n = len(ids)
    if n < 8:
        return {"rep": 0.0, "hit_cap": 0.0}
    grams = [tuple(ids[i:i + 4]) for i in range(n - 3)]
    rep = 1.0 - len(set(grams)) / max(1, len(grams))
    return {"rep": float(rep), "hit_cap": 0.0}

def run_hf(torch, cfg):
    model_dir = cfg.get("model_dir")
    if not model_dir or not os.path.isdir(model_dir):
        fail(f"model_dir is not a directory: {model_dir}")
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as e:
        fail(f"transformers is not importable: {e}")

    prompts = cfg.get("prompts") or ["Solve 7*8 step by step."]
    max_new = int(cfg.get("max_new_tokens", 48))
    max_frac = float(cfg.get("max_edit_fraction", 0.0002))
    scan_layers = int(cfg.get("scan_layers", 4))

    log(f"loading {model_dir} (local_files_only=True)")
    tok = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_dir, local_files_only=True, torch_dtype=torch.float32,
        device_map="cpu", low_cpu_mem_usage=True,
    )
    model.eval()

    def generate(text):
        enc = tok(text, return_tensors="pt")
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=max_new, do_sample=False,
                                 pad_token_id=tok.eos_token_id)
        return out[0][enc["input_ids"].shape[1]:].tolist()

    def score_all():
        rows = []
        for p in prompts:
            ids = generate(p)
            m = repetition_metrics(torch, ids)
            rows.append({"prompt": p[:80], "tokens": len(ids), **m,
                         "text": tok.decode(ids, skip_special_tokens=True)[:240]})
        rep = sum(r["rep"] for r in rows) / max(1, len(rows))
        return {"repetition": round(rep, 4), "rows": rows}

    before = score_all()
    log(f"baseline repetition={before['repetition']}")

    layers = getattr(getattr(model, "model", model), "layers", [])
    if not layers:
        fail("this model exposes no decoder layers at a known path; refusing to guess")

    # candidate tensors: attention output projection + MLP down projection
    def matrix_of(layer, which):
        m = layer.self_attn.o_proj if which == "attn" else layer.mlp.down_proj
        return m.weight

    step = max(1, len(layers) // max(1, scan_layers))
    candidates = []
    for i in range(0, len(layers), step):
        for which in ("attn", "mlp"):
            try:
                matrix_of(layers[i], which)
                candidates.append((i, which))
            except Exception:
                pass

    # causal scan: zero one matrix at a time, measure repetition change
    attribution = []
    for (i, which) in candidates:
        w = matrix_of(layers[i], which)
        saved = w.detach().clone()
        with torch.no_grad():
            w.zero_()
        s = score_all()["repetition"]
        with torch.no_grad():
            w.copy_(saved)
        attribution.append({"layer": i, "which": which,
                            "repetition_after_ablation": s,
                            "drop": round(before["repetition"] - s, 4)})
    attribution.sort(key=lambda r: r["drop"], reverse=True)
    log(f"ablation: {json.dumps(attribution[:4])}")

    best = {"repetition": before["repetition"], "scale": 0.0, "edits": []}
    evaluated = 0
    # damp the top singular direction in the two worst matrices, sparsely
    for cand in attribution[:2]:
        i, which = cand["layer"], cand["which"]
        w = matrix_of(layers[i], which)
        u = torch.linalg.svd(w.float(), full_matrices=False)[2][0]
        proj = (w.float() @ u).abs()
        k = max(1, int(w.numel() * max_frac))
        flat = torch.topk(proj.reshape(-1), k).indices
        rows = torch.div(flat, w.shape[1], rounding_mode="floor")
        cols = flat % w.shape[1]
        saved = w.detach().clone()
        for scale in [0.25, 0.5, 0.75, 1.0]:
            with torch.no_grad():
                w.copy_(saved)
                w[rows, cols] = w[rows, cols] - (w[rows, cols] * u[cols]) * scale
            rep = score_all()["repetition"]
            evaluated += 1
            log(f"  layer={i} {which} scale={scale} repetition={rep}")
            if rep < best["repetition"] - 1e-4:
                best = {"repetition": rep, "scale": scale,
                        "edits": [{"layer": i, "which": which, "k": int(k),
                                   "scale": scale}],
                        "rows": rows.clone(), "cols": cols.clone(), "u": u.clone()}
        with torch.no_grad():
            w.copy_(saved)

    if not best["edits"]:
        result = {"ok": False, "mode": "hf", "before": before, "after": before,
                  "error": "no scale reduced repetition; weights left untouched",
                  "evaluations": evaluated}
        return result

    # apply the winning edit and export a delta only
    e = best["edits"][0]
    w = matrix_of(layers[e["layer"]], e["which"])
    saved = w.detach().clone()
    with torch.no_grad():
        w[e["rows"], e["cols"]] = w[e["rows"], e["cols"]] - (w[e["rows"], e["cols"]] * best["u"][e["cols"]]) * e["scale"]
    after = score_all()

    delta = {}
    for i, layer in enumerate(layers):
        for which in ("attn", "mlp"):
            try:
                t = matrix_of(layer, which)
            except Exception:
                continue
            if i == e["layer"] and which == e["which"]:
                delta[f"layers.{i}.{which}"] = (t - saved).to(torch.float32).cpu()
    out = os.path.join(cfg["_dir"], "delta.safetensors")
    try:
        from safetensors.torch import save_file
        save_file(delta, out)
    except Exception as ex:
        log(f"safetensors unavailable ({ex}); delta not written")
        out = None

    return {
        "ok": after["repetition"] < before["repetition"] - 0.01,
        "mode": "hf",
        "before": before,
        "after": after,
        "edits": breadcrumbs(best),
        "evaluations": evaluated,
        "delta_file": out,
        "honest_notes": [
            "repetition is measured on the prompts listed, not on MATH-500",
            "a smaller repetition rate is not proof of better reasoning",
            "base model files were not modified",
        ],
    }

def breadcrumbs(best):
    return [{k: v for k, v in e.items() if k != "rows"} | {"fraction": None}
            for e in best.get("edits", [])]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    with open(a.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["_dir"] = os.path.dirname(os.path.abspath(a.config))

    torch = load_torch()
    mode = cfg.get("mode", "synthetic")

    if a.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "mode": mode,
                          "torch": torch.__version__}), flush=True)
        return

    t0 = time.time()
    if mode == "synthetic":
        result = run_synthetic(torch, cfg)
    elif mode == "hf":
        result = run_hf(torch, cfg)
    else:
        fail(f"unknown mode {mode}")

    result["seconds"] = round(time.time() - t0, 2)
    with open(os.path.join(cfg["_dir"], "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print("RESULT " + json.dumps(result), flush=True)

if __name__ == "__main__":
    main()
