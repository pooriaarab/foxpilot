"""Reference outputs from the Python gliner2 library for the calls the agent makes.

Runs goal extraction (extract_entities with the agent's VALUE_TYPES) and
control scoring (Classifier.batch_classify with a softmax "referenced" schema)
on fastino/gliner2-multi-v1, and records for every call the exact token ids
and gather positions the processor produced, so the browser port can be
checked token for token and score for score.

Usage: python export/reference.py  → export/reference.json
"""
import json
import re
from pathlib import Path

from gliner2.classification import ClassificationSchema, Classifier

MODEL = "fastino/gliner2-multi-v1"
OUT = Path(__file__).with_name("reference.json")

# From gliner2-ultrafast gliner.py (MIT).
VALUE_TYPES = {
    "location": "a place, city, country, airport or address",
    "date": "a calendar date or day",
    "time": "a clock time",
    "number": "a count, quantity or amount",
    "person": "a person's name",
    "organization": "a company, brand or organisation name",
    "money": "a price or monetary amount",
    "product": "a product, package, library, tool or software name",
    "title": "the title of a book, article, page or work",
}
KINDS = {
    "fill": "a text field to type a value into",
    "select": "a dropdown value to choose",
    "click": "a button or link to press",
}
VERBS = (
    "open|click|press|select|choose|go|view|find|search|set|enter|type|add|remove|check|"
    "uncheck|submit|close|show|read|download|install|book|buy|sort|filter|apply|confirm"
)
SPLIT = re.compile(
    r"(?<=\s)(?=(?:from|to|on|in|at|for|with|by|into|about|between|before|after|during|"
    rf"without|under|over|near|then)\s)|(?<=\s)(?=and\s+(?:{VERBS})\b)|(?<=[.;:])\s+",
    re.IGNORECASE,
)
RESERVED = re.compile(r"\[(?:P|C|E|R|L|DESCRIPTION|EXAMPLE|OUTPUT)\]|[()\[\]]")


def clean(value, limit=90):
    text = RESERVED.sub(" ", str(value if value is not None else ""))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def parts_of(goal):
    return [p.strip(" ,.;:") for p in SPLIT.split(clean(goal, 600)) if len(p.strip(" ,.;:")) >= 2]


GOALS = [
    "Find a one-way ticket from New York to San Francisco on October 9, 2026.",
    "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking.",
    "Book a table for 4 people at Nopa on Friday at 7:30 pm.",
    "Search for noise cancelling headphones under $300 and sort by price.",
    "Open the React documentation and find the useEffect page.",
    "Trouver un vol de Paris à Lisbonne le 3 novembre.",
]

# A Google Flights-like page: (label, kind).
FLIGHTS_CONTROLS = [
    ("Round trip", "select"),
    ("One way", "select"),
    ("1 passenger", "click"),
    ("Economy", "select"),
    ("Where from?", "fill"),
    ("Where to?", "fill"),
    ("Departure", "fill"),
    ("Return", "fill"),
    ("Search", "click"),
    ("Explore destinations", "click"),
    ("Swap origin and destination", "click"),
    ("Sign in", "click"),
]
MAPS_CONTROLS = [
    ("Search Google Maps", "fill"),
    ("Directions", "click"),
    ("Choose starting point, or click on the map", "fill"),
    ("Choose destination", "fill"),
    ("Driving", "click"),
    ("Transit", "click"),
    ("Walking", "click"),
    ("Cycling", "click"),
    ("Menu", "click"),
]


def main():
    clf = Classifier.from_pretrained(MODEL).eval()
    model = clf.model
    processor = model.processor

    captured = []
    original = processor.collate_fn_inference

    def hook(rows, *args, **kwargs):
        batch = original(rows, *args, **kwargs)
        for i in range(len(batch.input_ids)):
            n_words = int(batch.text_word_counts[i])
            captured.append({
                "input_ids": batch.input_ids[i][batch.attention_mask[i].bool()].tolist(),
                "word_positions": batch.text_word_indices[i, :n_words].tolist(),
                "schema_positions": [list(map(int, s)) for s in batch.schema_special_indices[i]],
                "schema_tokens": batch.schema_tokens_list[i],
                "text_tokens": list(batch.text_tokens[i]),
                "start_map": list(map(int, batch.start_mappings[i])),
                "end_map": list(map(int, batch.end_mappings[i])),
            })
        return batch

    processor.collate_fn_inference = hook

    cases = []
    for goal in GOALS:
        text = clean(goal, 600)
        captured.clear()
        result = model.extract_entities(text, VALUE_TYPES, include_confidence=True, include_spans=True)
        assert len(captured) == 1, len(captured)
        cases.append({"kind": "extract", "text": text, "labels": VALUE_TYPES, "tensors": captured[0],
                      "result": result})

    for goal, controls in [(GOALS[0], FLIGHTS_CONTROLS), (GOALS[1], MAPS_CONTROLS)]:
        labels = {clean(label): KINDS[kind] for label, kind in controls}
        schema = ClassificationSchema().single("referenced", labels, activation="softmax")
        texts = parts_of(goal)
        captured.clear()
        answers = clf.batch_classify(texts, schema)
        assert len(captured) == len(texts), (len(captured), len(texts))
        for text, answer, tensors in zip(texts, answers, captured):
            cases.append({"kind": "classify", "text": text, "labels": labels, "tensors": tensors,
                          "result": dict(answer.probabilities("referenced"))})

    OUT.write_text(json.dumps({"model": MODEL, "cases": cases}, indent=1, ensure_ascii=False))
    for c in cases:
        if c["kind"] == "extract":
            print("EXTRACT", c["text"][:60], "→", json.dumps(c["result"], ensure_ascii=False)[:220])
        else:
            best = max(c["result"], key=c["result"].get)
            print("CLASSIFY", c["text"][:40].ljust(40), "→", best, round(c["result"][best], 3))


if __name__ == "__main__":
    main()
