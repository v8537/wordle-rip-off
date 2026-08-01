#!/usr/bin/env python3
"""Keeps data/answers.json stocked with a rolling window of NYT Wordle answers.

Fetches https://www.nytimes.com/svc/wordle/v2/<date>.json, which has no CORS headers, so the
static site's browser JS can't call it directly -- this script runs server-side instead, on a
schedule (see ../launchd/com.wordle.scrape.plist), and pushes the result so GitHub Pages picks
it up as a plain static file.

The window is wide enough to cover any visitor's local calendar date relative to whenever this
happens to run (UTC offsets span -12 to +14), since the real Wordle -- and this rip-off -- picks
the day's word from the player's own device date, not a single global cutover.
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = REPO_DIR / "data" / "answers.json"

WINDOW_BEFORE = 2
WINDOW_AFTER = 3


def fetch_day(day):
    url = f"https://www.nytimes.com/svc/wordle/v2/{day.isoformat()}.json"
    req = urllib.request.Request(url, headers={"User-Agent": "wordle-rip-off-scraper/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def load_existing():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text())
    return {}


def git(*args):
    subprocess.run(["git", *args], cwd=REPO_DIR, check=True)


def main():
    git("fetch", "origin", "main")
    git("merge", "--ff-only", "origin/main")

    answers = load_existing()
    today = date.today()
    changed = False

    for offset in range(-WINDOW_BEFORE, WINDOW_AFTER + 1):
        day = today + timedelta(days=offset)
        key = day.isoformat()
        if key in answers:
            continue
        try:
            data = fetch_day(day)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            print(f"{key}: HTTP {e.code}", file=sys.stderr)
            continue
        except Exception as e:
            print(f"{key}: {e}", file=sys.stderr)
            continue
        answers[data["print_date"]] = data
        changed = True
        print(f"{key}: fetched '{data['solution']}'")

    # Trim entries well outside the window so the file doesn't grow forever.
    cutoff_low = (today - timedelta(days=WINDOW_BEFORE + 2)).isoformat()
    cutoff_high = (today + timedelta(days=WINDOW_AFTER + 2)).isoformat()
    pruned = {k: v for k, v in answers.items() if cutoff_low <= k <= cutoff_high}
    if pruned != answers:
        changed = True
    answers = pruned

    if not changed:
        print("no changes")
        return

    DATA_FILE.write_text(json.dumps(dict(sorted(answers.items())), indent=2) + "\n")

    git("add", "data/answers.json")
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=REPO_DIR).returncode == 0:
        print("no diff to commit")
        return

    git("commit", "-m", f"Update word cache ({today.isoformat()})")
    git("push", "origin", "main")
    print("pushed")


if __name__ == "__main__":
    main()
