"""
LLM client factory and uniform completion interface.

The rest of the codebase calls into this module for any LLM work.
Direct imports of the Anthropic or OpenAI SDKs should appear ONLY here.
That way, adding a new provider is a one-file change.

Two entry points:

    complete(prompt, max_tokens=...) -> str
        Single-prompt text completion. Hides Anthropic vs OpenAI API
        differences from callers. Used everywhere the codebase wants
        to "ask the LLM something and get a string back."

    get_embedding_provider_kwargs() -> dict
        Returns the kwargs to pass into LlamaIndex's OpenAIEmbedding.
        Used by extraction.py during LlamaIndex setup.
"""
from app.core.config import config


def complete(prompt: str, max_tokens: int = 1024) -> str:
    """
    Single-prompt completion that hides provider differences.

    Returns the model's text response as a plain string. Caller doesn't
    need to know whether the underlying provider was Anthropic, OpenAI,
    or a gateway.

    Used by:
      - synthesize_entity_descriptions (in extraction.py)
      - the /context endpoint (in routers/aks.py)
      - the page generator (in core/page_generator.py)
      - the synthesis backfill router (in routers/synthesize.py)
    """
    provider = config.EXTRACTION_PROVIDER

    if provider == "anthropic":
        from anthropic import Anthropic
        client = Anthropic(api_key=config.ANTHROPIC_API_KEY)
        response = client.messages.create(
            model=config.EXTRACTION_MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text.strip()

    if provider == "openai":
        from openai import OpenAI
        client = OpenAI(api_key=config.OPENAI_API_KEY)
        response = client.chat.completions.create(
            model=config.EXTRACTION_MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content.strip()

    if provider == "gateway":
        # Gateway is OpenAI-compatible by convention. Use OpenAI SDK
        # pointed at the gateway URL.
        from openai import OpenAI
        client = OpenAI(
            api_key=config.GATEWAY_API_KEY,
            base_url=config.GATEWAY_URL,
        )
        response = client.chat.completions.create(
            model=config.EXTRACTION_MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content.strip()

    raise ValueError(f"Unknown EXTRACTION_PROVIDER: {provider}")


def get_embedding_provider_kwargs() -> dict:
    """
    Return the kwargs to pass into LlamaIndex's OpenAIEmbedding constructor.

    LlamaIndex's OpenAIEmbedding accepts an `api_base` parameter that
    points it at any OpenAI-compatible endpoint, which is how we plug in
    a gateway. The user picks EMBEDDING_PROVIDER and the right kwargs
    are returned.
    """
    provider = config.EMBEDDING_PROVIDER

    if provider == "openai":
        return {
            "model": config.EMBEDDING_MODEL,
            "api_key": config.OPENAI_API_KEY,
        }

    if provider == "gateway":
        return {
            "model": config.EMBEDDING_MODEL,
            "api_key": config.GATEWAY_API_KEY,
            "api_base": config.GATEWAY_URL,
        }

    raise ValueError(f"Unknown EMBEDDING_PROVIDER: {provider}")
