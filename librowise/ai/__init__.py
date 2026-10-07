"""AI features.

Every feature has two engines:

* **Claude** (``claude-opus-5-5``) when Anthropic credentials are configured — natural-language
  query understanding, cataloguing suggestions and a tool-using staff copilot.
* **Local** models that need no network or API key — a sparse TF-IDF index with concept
  expansion, rule-based query parsing, nearest-neighbour subject propagation, collaborative
  filtering and heuristic risk scoring.

Callers never need to know which engine answered; responses carry an ``engine`` field.
"""
