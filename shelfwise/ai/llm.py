"""Thin wrapper around the Anthropic SDK with graceful degradation."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from ..config import get_settings

log = logging.getLogger("shelfwise.ai")

FALLBACK_BETA = "server-side-fallback-2026-07-01"

_client = None
_disabled_until = 0.0


def credentials_present() -> bool:
    if any(os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE")):
        return True
    return (Path.home() / ".config" / "anthropic").exists()


def available() -> bool:
    s = get_settings()
    return bool(s.ai_enabled and s.environment != "test" and time.time() >= _disabled_until
                and credentials_present())


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(timeout=get_settings().ai_timeout, max_retries=2)
    return _client


def _back_off(seconds: float = 300) -> None:
    global _disabled_until
    _disabled_until = time.time() + seconds


def _create(**kwargs):
    """messages.create with server-side refusal fallback enabled. Returns None on failure."""
    import anthropic

    s = get_settings()
    try:
        response = _get_client().beta.messages.create(
            model=s.ai_model,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": s.ai_effort, **kwargs.pop("output_config", {})},
            **kwargs,
        )
    except anthropic.AuthenticationError:
        log.warning("Anthropic credentials rejected; using local AI engine for 5 minutes")
        _back_off()
        return None
    except anthropic.RateLimitError:
        log.warning("Anthropic rate limit hit; using local AI engine for 60s")
        _back_off(60)
        return None
    except anthropic.APIStatusError as exc:
        log.warning("Anthropic API error %s: %s", exc.status_code, exc.message)
        if exc.status_code >= 500:
            _back_off(30)
        return None
    except anthropic.APIConnectionError:
        log.warning("Cannot reach the Anthropic API; using local AI engine for 2 minutes")
        _back_off(120)
        return None
    if response.stop_reason == "refusal":
        log.info("Claude declined the request (%s)", getattr(response, "stop_details", None))
        return None
    return response


def complete_json(system: str, prompt: str, schema: dict, *, max_tokens: int = 4000) -> dict | None:
    """Single structured-output call. Returns the parsed object or None if unavailable."""
    if not available():
        return None
    response = _create(
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    if response is None:
        return None
    text = "".join(b.text for b in response.content if b.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        log.warning("Structured output was not valid JSON")
        return None


def run_tool_loop(
    system: str,
    messages: list[dict],
    tools: list[dict],
    execute: Any,
    *,
    max_turns: int = 6,
    max_tokens: int = 8000,
) -> tuple[str, list[dict]] | None:
    """Manual agentic loop over read-only tools. ``execute(name, input) -> dict``.

    Returns (final_text, trace) or None if Claude is unavailable.
    """
    if not available():
        return None
    trace: list[dict] = []
    convo = list(messages)
    for _ in range(max_turns):
        response = _create(max_tokens=max_tokens, system=system, messages=convo, tools=tools)
        if response is None:
            return None
        convo.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in response.content]})
        if response.stop_reason != "tool_use":
            text = "".join(b.text for b in response.content if b.type == "text")
            return text.strip(), trace
        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            try:
                output = execute(block.name, dict(block.input or {}))
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": json.dumps(output, default=str)[:20000]})
                trace.append({"tool": block.name, "input": block.input, "ok": True})
            except Exception as exc:  # report tool errors back to the model
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": f"Error: {exc}", "is_error": True})
                trace.append({"tool": block.name, "input": block.input, "ok": False})
        convo.append({"role": "user", "content": results})
    return "I ran out of steps while working on that — try a more specific question.", trace
