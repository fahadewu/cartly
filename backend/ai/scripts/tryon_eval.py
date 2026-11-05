"""Paid quality test of the AI try-on (FASHN) before shoppers see it: every wearable product on two
sample models, and full looks at different quality settings, as a contact sheet to review.

    .venv/bin/python -m scripts.tryon_eval          # prints the plan and what it would cost; renders nothing
    .venv/bin/python -m scripts.tryon_eval --yes    # renders, and stops before going over --budget credits

Runs the storefront's own code path (/tryon/render) in-process, with FASHN_API_KEY from backend/.env.
Cached steps cost nothing, so a re-run only pays for what changed. Output: .tryon-eval/<time>/index.html
"""
import argparse
import asyncio
import base64
import html
import time
from datetime import datetime
from pathlib import Path

import httpx

from app import db, tryon
from app.catalog import catalog
from app.config import AI_DIR, settings
from app.main import RenderRequest, tryon_render
from app.redis_client import close_redis

CREDITS = {"fast": {"1k": 1, "2k": 2, "4k": 3}, "balanced": {"1k": 2, "2k": 3, "4k": 4}, "quality": {"1k": 3, "2k": 4, "4k": 5}}
USD_PER_CREDIT = 0.075  # FASHN API, on demand
MODELS = ["Model A", "Model B", "Model C", "Model D"]  # tryon.SAMPLE_MODELS: two women (A, C), two men (B, D)
MODELS_FOR = {"women": (0, 2), "men": (1, 3), "unisex": (0, 1)}
LOOKS = [("Casual", 0, [5, 19, 1]), ("Occasion", 2, [17, 14, 25]), ("Street", 1, [9, 24, 40])]


def plan() -> list[dict]:
    jobs = []
    for p in sorted(catalog.products, key=lambda p: p["id"]):
        if p.get("tryOnSlot"):
            for m in MODELS_FOR.get(p.get("gender"), (0, 1)):
                jobs.append({"phase": "Every product (balanced, 1k)", "title": p["name"], "sample": m, "ids": [p["id"]], "mode": "balanced", "res": "1k"})
    for mode, res in [("balanced", "1k"), ("balanced", "2k")]:
        for name, m, ids in LOOKS:
            jobs.append({"phase": f"Full looks ({mode}, {res})", "title": name, "sample": m, "ids": ids, "mode": mode, "res": res})
    name, m, ids = LOOKS[0]
    jobs.append({"phase": "Full looks (quality, 2k)", "title": name, "sample": m, "ids": ids, "mode": "quality", "res": "2k"})
    for j in jobs:
        j["credits"] = len(j["ids"]) * CREDITS[j["mode"]][j["res"]]
    return jobs


def configure(**kw):
    for k, v in kw.items():
        object.__setattr__(settings, k, v)  # settings are frozen; this run needs its own mode and no hourly cap


async def save(image: str, path: Path) -> None:
    if image.startswith("data:"):
        path.write_bytes(base64.b64decode(image.split(",", 1)[1]))
    else:
        async with httpx.AsyncClient(timeout=60) as http:
            path.write_bytes((await http.get(image)).content)


def page(jobs: list[dict]) -> str:
    rows, phase = [], None
    for j in jobs:
        if j["phase"] != phase:
            phase = j["phase"]
            rows.append(f"</div><h2>{html.escape(phase)}</h2><div class='grid'>")
        items = "<br>" + ", ".join(html.escape(catalog.get(i)["name"]) for i in j["ids"]) if len(j["ids"]) > 1 else ""
        model = tryon.SAMPLE_MODELS[j["sample"]].replace("w=1100", "w=120")
        thumbs = f"<img class='item' src='{model}' title='before'>" + "".join(
            f"<img class='item' src='{html.escape(catalog.get(i)['image'])}'>" for i in j["ids"]
        )
        result = f"<img class='out' src='{j['file']}'>" if j.get("file") else f"<div class='err'>{html.escape(j.get('error', 'not rendered'))}</div>"
        meta = f"{MODELS[j['sample']]} · {j.get('seconds', 0):.0f}s · {j.get('spent', 0)} credits" + (" (cached)" if j.get("cached_all") else "")
        rows.append(f"<figure>{result}<div class='items'>{thumbs}</div><figcaption><b>{html.escape(j['title'])}</b>{items}<br><small>{meta}</small></figcaption></figure>")
    return (
        "<!doctype html><meta charset='utf-8'><title>Try-on quality test</title><style>"
        "body{font:14px system-ui;margin:24px;background:#fafafa}h2{margin:28px 0 10px}"
        ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}"
        "figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:10px;overflow:hidden}"
        ".out{width:100%;display:block}.items{display:flex;gap:4px;padding:6px}.item{width:48px;height:48px;object-fit:cover;border-radius:6px}"
        "figcaption{padding:0 10px 10px}.err{padding:40px 10px;color:#b00;text-align:center}</style>"
        f"<h1>Try-on quality test</h1><p>{datetime.now():%Y-%m-%d %H:%M} · {sum(j.get('spent', 0) for j in jobs)} credits spent</p><div>"
        + "".join(rows)
        + "</div>"
    )


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yes", action="store_true", help="render (costs credits)")
    ap.add_argument("--budget", type=int, default=200, help="most credits to spend (default 200, about $15)")
    ap.add_argument("--parallel", type=int, default=4, help="renders at a time")
    args = ap.parse_args()

    await db.open_pool()
    await catalog.load()
    jobs = plan()
    total = sum(j["credits"] for j in jobs)
    phases = {}
    for j in jobs:
        phases[j["phase"]] = phases.get(j["phase"], 0) + j["credits"]
    for name, credits in phases.items():
        print(f"  {name:36} {credits:4} credits")
    print(f"  {'Total (at most; cached steps are free)':36} {total:4} credits ≈ ${total * USD_PER_CREDIT:.2f}")
    if not args.yes:
        print("Nothing rendered. Add --yes to run it.")
        return 0
    if not tryon.configured():
        print("Set FASHN_API_KEY in backend/.env first.")
        return 2

    out = AI_DIR / ".tryon-eval" / datetime.now().strftime("%Y%m%d-%H%M")
    out.mkdir(parents=True, exist_ok=True)
    configure(tryon_hourly_limit=0)
    reserved = 0
    gate = asyncio.Semaphore(args.parallel)

    async def run(n: int, j: dict):
        nonlocal reserved
        if reserved + j["credits"] > args.budget:
            j["error"] = "skipped: over budget"
            return
        reserved += j["credits"]  # the most it can cost, so parallel renders can't overshoot
        async with gate:
            configure(tryon_mode=j["mode"], tryon_resolution=j["res"])
            started = time.monotonic()
            res = await tryon_render(
                RenderRequest(user_id="eval", sample=j["sample"], items=[{"id": i} for i in j["ids"]]),
                x_internal_key=settings.internal_api_key,
            )
            j["seconds"] = time.monotonic() - started
        if isinstance(res, dict):
            j["spent"] = res["rendered"] * CREDITS[j["mode"]][j["res"]]
            j["cached_all"] = res["rendered"] == 0
            j["file"] = f"{n:03}.jpg"
            await save(res["image"], out / j["file"])
        else:
            j["error"] = res.body.decode()
        reserved -= j["credits"] - j.get("spent", 0)
        outcome = j.get("error") or f"{j['spent']} credits"
        print(f"  {n + 1}/{len(jobs)} {j['title']} on {MODELS[j['sample']]} ({j['mode']}, {j['res']}): {outcome}")

    # Settings are per job, so jobs with the same settings run together, one setting at a time.
    for key in dict.fromkeys((j["mode"], j["res"]) for j in jobs):
        await asyncio.gather(*(run(n, j) for n, j in enumerate(jobs) if (j["mode"], j["res"]) == key))
    (out / "index.html").write_text(page(jobs), encoding="utf-8")
    spent = sum(j.get("spent", 0) for j in jobs)
    print(f"Spent {spent} credits (≈ ${spent * USD_PER_CREDIT:.2f}). Open {out / 'index.html'}")
    await db.close_pool()
    await close_redis()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
