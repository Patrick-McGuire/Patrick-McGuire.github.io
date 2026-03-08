import requests
import random
import json
import numpy as np

TBA_KEY = "ElyWdtB6HR7EiwdDXFmX2PDXQans0OMq83cdBcOhwri2TTXdMeYflYARvlbDxYe6"
EVENT_KEY = "2025new"
OUT_FILE = "scouting_data.txt"

HEADERS = {"X-TBA-Auth-Key": TBA_KEY}


def tba_get(url):
    r = requests.get(url, headers=HEADERS)
    r.raise_for_status()
    return r.json()


# ---------------------------
# Fetch Event Data
# ---------------------------
print("Fetching matches and teams...")
matches = tba_get(f"https://www.thebluealliance.com/api/v3/event/{EVENT_KEY}/matches/simple")
teams = tba_get(f"https://www.thebluealliance.com/api/v3/event/{EVENT_KEY}/teams/simple")

team_numbers = [int(t["team_number"]) for t in teams]

# Only keep real played matches
matches = [
    m for m in matches
    if m["actual_time"] is not None and m["comp_level"] == "qm"
]

# ---------------------------
# Team Skill Generation
# ---------------------------
def make_team_skill():
    return {
        "auto_fuel": np.random.normal(20, 8),
        "tele_fuel": np.random.normal(35, 12),
        "accuracy": np.random.normal(60, 15),
        "defense": np.random.normal(2.5, 1),
        "climb": np.random.normal(1.5, 1)
    }


team_skill = {t: make_team_skill() for t in team_numbers}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------
# Record Generator
# ---------------------------
def generate_record(match_num, team):
    s = team_skill[team]

    auto_fuel = int(clamp(np.random.normal(s["auto_fuel"], 5), 0, 60))
    tele_fuel = int(clamp(np.random.normal(s["tele_fuel"], 8), 0, 100))

    auto_acc = int(clamp(np.random.normal(s["accuracy"], 10), 0, 100))
    tele_acc = int(clamp(np.random.normal(s["accuracy"], 10), 0, 100))

    defense_rating = int(clamp(np.random.normal(s["defense"], 1), 0, 5))
    climb_level = int(clamp(round(np.random.normal(s["climb"], 1)), -1, 3))

    return {
        "match": str(match_num),
        "team": str(team),
        "scout": "SimBot",

        "Starting Location": random.choice([
            "", "Trench - HP Side", "Bump - HP Side", "Goal",
            "Bump - Other Side", "Trench - Other Side"
        ]),

        "Auto Fuel Scored": str(auto_fuel),
        "Auto Feed Center": str(random.randint(0, 5)),
        "Auto Fuel Accuracy": str(auto_acc),
        "Auto Comments": random.choice(["", "clean auto", "missed shots", "good start"]),
        "Auto Climb": random.choice([0, 1]),
        "Auto Climb Location": random.choice([
            "", "Side - HP", "Upright - HP", "Center",
            "Side - Other Side", "Upright - Other Side"
        ]),

        "Tele Fuel Scored": str(tele_fuel),
        "Tele Feed Center": str(random.randint(0, 20)),
        "Tele Feed Far": str(random.randint(0, 10)),
        "Tele Fuel Accuracy": str(tele_acc),
        "Climb": str(climb_level),
        "Tele Climb Location": random.choice([
            "", "Side - HP", "Upright - HP", "Center",
            "Side - other", "Upright - other"
        ]),
        "Disconnected": random.choice([0, 0, 0, 1]),
        "Defence Rating": str(defense_rating),
        "Played Defence": random.choice([0, 1]),
        "Was Defended": random.choice([0, 1]),
        "Tele Comments": random.choice(["", "strong cycle", "slow intake", "good defense"])
    }


# ---------------------------
# Generate All Data
# ---------------------------
print("Generating synthetic scouting data...")

with open(OUT_FILE, "w") as f:
    for m in matches:
        match_num = m["match_number"]
        for alliance in ["red", "blue"]:
            for team_key in m["alliances"][alliance]["team_keys"]:
                team = int(team_key.replace("frc", ""))
                record = generate_record(match_num, team)
                f.write(json.dumps(record) + "\n")

print(f"Done. Wrote data to {OUT_FILE}")
