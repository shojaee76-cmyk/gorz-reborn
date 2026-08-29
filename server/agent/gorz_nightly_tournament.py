#!/usr/bin/env python
"""Hermes no_agent cron: nightly 4-gen Gorz tournament, post champion.

Run nightly via `hermes cron create ... --no-agent --script ... --deliver <channel>`.
Stdout is delivered verbatim. Empty stdout = silent. Exit non-zero = error to user.

Behaviour:
  1. ping gorz server /api/agent/health (5s timeout). If down, print clear error & exit 1.
  2. pick a date-scoped lineage (nightly-YYYY-MM-DD) so runs never collide.
  3. cd /c/Users/capit/gorz-reborn and run `node server/agent/run-tournament.js <lineage> 12 4`
     with a hard 540s timeout (under the 600s cron idle limit).
  4. parse stdout for the champion (last leaderboard #1 line) — id, fitness, fingerprint.
  5. GET /api/agent/population?lineage=<lineage>&limit=1 to fetch the top agent record
     (composition / parent / decisive_rate).
  6. print a Telegram-friendly one-liner the cron runner will deliver.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

WORKDIR = r"C:\Users\capit\gorz-reborn"
TOURNAMENT = os.path.join(WORKDIR, "server", "agent", "run-tournament.js")
GORZ_URL = os.environ.get("GORZ_URL", "http://localhost:3000")
POP_SIZE = 12
GENS = 4
# Stay well under the 600s cron idle limit. 4 gens of 12 = ~minute or two on a warm
# server; 540s gives margin for a slow first run without overlapping the next cron.
TOURNAMENT_TIMEOUT = 540
HEALTH_TIMEOUT = 5


def err(msg: str) -> int:
    # A leading emoji keeps the message visible in noisy Telegram/desktop channels.
    print(f"❌ Gorz nightly tournament FAILED: {msg}")
    return 1


def healthcheck() -> bool:
    try:
        with urllib.request.urlopen(f"{GORZ_URL}/api/agent/health", timeout=HEALTH_TIMEOUT) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
        return bool(body.get("ok"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        print(f"[healthcheck] {type(e).__name__}: {e}", file=sys.stderr)
        return False


LEADERBOARD_RE = re.compile(
    r"#1\s+id=(\d+)\s+gen=(\d+)\s+fitness=([\d.]+)\s+w=(\d+)\s+l=(\d+)\s+d=(\d+)\s+fp=(\S+)"
)


def parse_champion(stdout: str) -> dict | None:
    """Pull the last '#1 ...' leaderboard line and any 'parent=' hint from stdout."""
    matches = list(LEADERBOARD_RE.finditer(stdout))
    if not matches:
        return None
    m = matches[-1]
    champ = {
        "id": int(m.group(1)),
        "gen": int(m.group(2)),
        "fitness": float(m.group(3)),
        "wins": int(m.group(4)),
        "losses": int(m.group(5)),
        "draws": int(m.group(6)),
        "fingerprint": m.group(7),
    }
    # run-tournament.js prints the '=== GEN N ===' banner with composition; the
    # very last such banner belongs to the final generation's #1 agent.
    gen_banners = re.findall(
        r"=== GEN (\d+) ===\s+matches=\d+\s+decisive=([\d.]+)%", stdout
    )
    if gen_banners:
        last_gen, decisive = gen_banners[-1]
        champ["final_gen"] = int(last_gen)
        champ["decisive_rate"] = float(decisive)
    return champ


def fetch_top_agent(lineage: str) -> dict | None:
    """GET /api/agent/population?lineage=<lineage>&limit=1 -> top record.

    The endpoint returns rows in DB order (creation order), not sorted by
    fitness, so we fetch a larger page and pick the highest-fitness agent
    ourselves. Keeps the script independent of any sort-on-server work.
    """
    try:
        with urllib.request.urlopen(
            f"{GORZ_URL}/api/agent/population?lineage={lineage}&limit=50",
            timeout=10,
        ) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        print(f"[fetch_top_agent] {type(e).__name__}: {e}", file=sys.stderr)
        return None
    agents = body.get("agents") or []
    if not agents:
        return None
    # The agents table is updated in-place by updateFitness (no new row per
    # update), so the top agent may sit at any DB id — sort by fitness desc.
    return max(agents, key=lambda a: float(a.get("fitness") or 0))


def main() -> int:
    today = dt.date.today()
    lineage = f"nightly-{today.isoformat()}"

    # Reconfigure stdout to UTF-8 (Windows defaults to cp1252 in some shells),
    # so the trophy / ellipsis chars deliver cleanly through no_agent stdout.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

    if not healthcheck():
        return err(f"server unreachable at {GORZ_URL} (is `npm start` up?)")

    if not os.path.exists(TOURNAMENT):
        return err(f"tournament script missing: {TOURNAMENT}")

    print(f"[cron] launching tournament lineage={lineage} pop={POP_SIZE} gens={GENS}", file=sys.stderr)
    try:
        proc = subprocess.run(
            ["node", TOURNAMENT, lineage, str(POP_SIZE), str(GENS)],
            cwd=WORKDIR,
            capture_output=True,
            text=True,
            timeout=TOURNAMENT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return err(f"tournament exceeded {TOURNAMENT_TIMEOUT}s hard timeout")
    except FileNotFoundError as e:
        return err(f"could not launch node: {e}")

    stdout = proc.stdout or ""
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        return err(f"exit={proc.returncode}; tail={tail}")

    champ = parse_champion(stdout)
    if not champ:
        tail = stdout.strip().splitlines()[-5:]
        return err(f"could not parse champion from stdout; tail={tail}")

    record = fetch_top_agent(lineage) or {}
    genome = record.get("genome") or {}
    comp = genome.get("composition") or {}
    swordsman = round(float(comp.get("swordsman", 0)) * 100)
    archer = round(float(comp.get("archer", 0)) * 100)
    cavalry = round(float(comp.get("cavalry", 0)) * 100)
    # Prefer the API record's fitness (exact) over the run-tournament stdout's
    # `.toFixed(0)` rounded value. Fall back to the parsed value if the record
    # was missing (fetch failed) or zero.
    record_fitness = float(record.get("fitness") or 0)
    fitness = record_fitness if record_fitness > 0 else champ["fitness"]
    record_wins = int(record.get("wins") or champ["wins"])
    record_losses = int(record.get("losses") or champ["losses"])
    record_draws = int(record.get("draws") or champ["draws"])
    parent_a = record.get("parentAId")
    parent_b = record.get("parentBId")
    if parent_a and parent_b:
        parent = f"id{parent_a} x id{parent_b}"
    elif parent_a:
        parent = f"id{parent_a} (asexual)"
    else:
        parent = "seed"
    name = f"id-{champ['id']}"
    decisive_pct = round(champ.get("decisive_rate", 0))

    # Prefer the full API fingerprint (with tactics) over the stdout's truncated one.
    full_fp = record.get("fingerprint") or champ["fingerprint"]
    fp = full_fp if len(full_fp) <= 64 else full_fp[:64] + "\u2026"

    msg = (
        "🏆 Gorz nightly tournament winner\n"
        f"lineage: {lineage}\n"
        f"champion: {name} (id={champ['id']}, gen={champ['gen']})\n"
        f"fitness: {fitness:.0f}  (W{record_wins}/L{record_losses}/D{record_draws})\n"
        f"composition: {swordsman}/{archer}/{cavalry}  decisive={decisive_pct}%\n"
        f"parent: {parent}\n"
        f"fingerprint: {fp}"
    )
    # stdout of a no_agent job IS the delivered message; print exactly this.
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())