# Application-level settings: the AI provider connection (base URL, API key,
# default model) used by describe.py. Per the product doc, this is scoped to
# the whole app, not a project - stored in its own file next to (not inside)
# backend/data/projects/, and never echoed back to the client or written into
# a project.json/export.
import json
from pathlib import Path

from fastapi import APIRouter, Body

router = APIRouter()

SETTINGS_FILE = Path(__file__).resolve().parents[1] / "data" / "settings.json"

DEFAULT_PROVIDER = {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "",
    "defaultModel": "",
}


def load_settings() -> dict:
    if not SETTINGS_FILE.exists():
        return {"aiProvider": dict(DEFAULT_PROVIDER)}
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"aiProvider": dict(DEFAULT_PROVIDER)}
    provider = {**DEFAULT_PROVIDER, **(data.get("aiProvider") or {})}
    return {"aiProvider": provider}


def save_settings(data: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _public_view(data: dict) -> dict:
    provider = data["aiProvider"]
    return {
        "aiProvider": {
            "baseUrl": provider["baseUrl"],
            "defaultModel": provider["defaultModel"],
            "hasApiKey": bool(provider["apiKey"]),
        }
    }


@router.get("/api/settings")
async def get_settings():
    return _public_view(load_settings())


@router.put("/api/settings")
async def put_settings(body: dict = Body(default={})):
    current = load_settings()
    provider = current["aiProvider"]
    incoming = body.get("aiProvider") or body  # accept either {aiProvider:{...}} or the flat object

    if "baseUrl" in incoming:
        provider["baseUrl"] = (incoming["baseUrl"] or "").strip() or DEFAULT_PROVIDER["baseUrl"]
    if "defaultModel" in incoming:
        provider["defaultModel"] = (incoming["defaultModel"] or "").strip()
    # An empty/absent apiKey means "leave the saved key alone" - the client
    # never gets the real key back to redisplay, so it can't round-trip one
    # the user didn't just type.
    if incoming.get("apiKey"):
        provider["apiKey"] = incoming["apiKey"].strip()

    save_settings(current)
    return _public_view(current)


@router.post("/api/settings/test")
async def test_settings(body: dict = Body(default={})):
    import httpx

    incoming = body.get("aiProvider") or body
    current = load_settings()["aiProvider"]
    base_url = (incoming.get("baseUrl") or current["baseUrl"] or "").rstrip("/")
    api_key = incoming.get("apiKey") or current["apiKey"]
    model = (incoming.get("defaultModel") or current["defaultModel"] or "").strip()

    if not base_url:
        return {"ok": False, "message": "No API base URL provided."}
    if not api_key:
        return {"ok": False, "message": "No API key provided."}

    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{base_url}/models", headers=headers)
        if res.status_code != 200:
            return {"ok": False, "message": f"Provider returned HTTP {res.status_code} listing models."}
        models = sorted(m["id"] for m in (res.json() or {}).get("data") or [] if m.get("id"))
    except Exception as exc:  # noqa: BLE001 - reported to the client, not raised
        return {"ok": False, "message": str(exc) or repr(exc)}

    catalog_note = f"{len(models)} model(s) in catalog." if models else "Catalog empty."
    if not model:
        return {"ok": True, "message": f"Connected - {catalog_note} Set a default model to also verify it can generate.", "models": models}

    # Listing /models only proves the key is well-formed enough to browse the
    # public catalog - OpenRouter accepts that call for keys that then get
    # rejected on real chat/completions requests. Run an actual (tiny, cheap)
    # completion against the configured model so a bad key or bad model slug
    # shows up here instead of surprising the user later in [Describe image].
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            gen_res = await client.post(
                f"{base_url}/chat/completions",
                headers={**headers, "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": "Reply with just: OK"}], "max_tokens": 5},
            )
        if gen_res.status_code == 200:
            return {"ok": True, "message": f"Connected - {catalog_note} Generation check with \"{model}\" succeeded.", "models": models}
        detail = gen_res.text[:300]
        return {
            "ok": False,
            "message": f"Catalog lists {len(models)} models, but a real generation request with \"{model}\" failed: HTTP {gen_res.status_code} {detail}",
            "models": models,
        }
    except Exception as exc:  # noqa: BLE001 - reported to the client, not raised
        return {"ok": False, "message": f"Generation check with \"{model}\" failed: {exc}", "models": models}
