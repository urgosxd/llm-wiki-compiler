"""
Document compilation pipeline.

THIS IS THE ONLY FILE IN THE PROJECT THAT IMPORTS LLAMA-INDEX.

Public functions:

    chunk_and_embed(text, stack_id, document_id) -> list[ChunkResult]
        Splits text into chunks, computes embeddings, returns objects
        ready to insert into document_chunks.

    embed_query(text) -> list[float]
        Embed a single query string for the /context endpoint.

    extract_graph_from_chunks(chunks, stack_name) -> ExtractionResult
        Runs LLM extraction across all chunks, returns deduplicated
        entities and relationships ready for consolidation.

    synthesize_entity_descriptions(extraction, chunks) -> None
        OPTIONAL pass that fills in description fields on every entity
        in the extraction result. One LLM call per entity. Mutates
        extraction in place. Off by default — opt in via Stack setting
        or per-call query parameter.

If you ever want to replace LlamaIndex with something else, you replace
this one file. Public function signatures stay the same.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from uuid import UUID

from llama_index.core import Settings, Document
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import TextNode
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.core.indices.property_graph import SchemaLLMPathExtractor

from app.core.config import config
from app.core.llm_clients import complete, get_embedding_provider_kwargs


# ============================================================================
# PUBLIC TYPES
# ============================================================================

@dataclass
class ChunkResult:
    """One chunk of a document, ready to insert into document_chunks."""
    document_id: UUID
    stack_id: UUID
    chunk_index: int
    content: str
    content_hash: str
    token_count: int
    embedding: list[float]
    chunker_strategy: str = "sentence"


@dataclass
class ExtractedEntity:
    """One entity extracted from one or more chunks. Pre-consolidation."""
    name: str
    type: str
    description: str
    confidence: float
    source_chunk_indices: list[int] = field(default_factory=list)


@dataclass
class ExtractedRelationship:
    """One relationship extracted from one or more chunks. Pre-consolidation."""
    from_entity_name: str
    to_entity_name: str
    type: str
    description: str
    confidence: float
    source_chunk_indices: list[int] = field(default_factory=list)


@dataclass
class ExtractionResult:
    """Combined output of an extraction run across all chunks of a document."""
    entities: list[ExtractedEntity]
    relationships: list[ExtractedRelationship]
    model: str
    pipeline: str = "llamaindex-schema-extraction"


# ============================================================================
# LLAMAINDEX GLOBAL CONFIGURATION
# ============================================================================

# Conservative default for gateway-hosted models LlamaIndex does not know.
# Used only for local context budgeting; never sent to the provider.
_GATEWAY_CONTEXT_WINDOW = 128_000


def _register_gateway_model(openai_utils, model: str, context_window: int) -> None:
    """
    Teach LlamaIndex's OpenAI wrapper about a gateway-only model name.

    `OpenAILLM` resolves the context window through
    `openai_modelname_to_contextsize`, which raises for any model missing from
    `ALL_AVAILABLE_MODELS`. A gateway model (`hf:deepseek-ai/...`) is never in
    that table, so construction fails before a request can be made.

    Adding the entry is the documented way through: the value is a local
    budgeting hint only, and the model name is still what gets sent upstream,
    so the gateway routes on the real identifier.

    This is a workaround for a LlamaIndex limitation, kept in one place so the
    rest of the module never has to know about it.
    """
    if model in openai_utils.ALL_AVAILABLE_MODELS:
        return
    openai_utils.ALL_AVAILABLE_MODELS[model] = context_window
    openai_utils.CHAT_MODELS[model] = context_window


def _configure_llamaindex() -> None:
    """
    Wire chosen models into LlamaIndex's global Settings.

    Embeddings always use the OpenAIEmbedding wrapper because both direct
    OpenAI and gateways present the same OpenAI-compatible API.

    Extraction uses one of three LlamaIndex LLM wrappers depending on
    EXTRACTION_PROVIDER. SchemaLLMPathExtractor needs a LlamaIndex LLM
    instance specifically — we can't use the simpler complete() helper
    here because the extractor wants the LLM wrapper.
    """
    # Embeddings
    Settings.embed_model = OpenAIEmbedding(**get_embedding_provider_kwargs())

    # Extraction LLM
    if config.EXTRACTION_PROVIDER == "anthropic":
        from llama_index.llms.anthropic import Anthropic as LIAnthropic
        Settings.llm = LIAnthropic(
            model=config.EXTRACTION_MODEL,
            api_key=config.ANTHROPIC_API_KEY,
            max_tokens=4096,
        )
    elif config.EXTRACTION_PROVIDER == "openai":
        from llama_index.llms.openai import OpenAI as LIOpenAI
        Settings.llm = LIOpenAI(
            model=config.EXTRACTION_MODEL,
            api_key=config.OPENAI_API_KEY,
            max_tokens=4096,
        )
    elif config.EXTRACTION_PROVIDER == "gateway":
        # Gateway is OpenAI-compatible. Use the LlamaIndex OpenAI wrapper
        # with api_base pointed at the gateway.
        #
        # LlamaIndex resolves a model's context window against its own table
        # of OpenAI models and raises for anything it does not recognise, so a
        # gateway model name like `hf:deepseek-ai/...` fails before the wrapper
        # is even built. Registering the name with a context size is the
        # supported way past that lookup; the size is only used for local
        # budgeting and is never sent upstream.
        from llama_index.llms.openai import OpenAI as LIOpenAI
        from llama_index.llms.openai import utils as li_openai_utils

        _register_gateway_model(
            li_openai_utils, config.EXTRACTION_MODEL, _GATEWAY_CONTEXT_WINDOW
        )
        Settings.llm = LIOpenAI(
            model=config.EXTRACTION_MODEL,
            api_key=config.GATEWAY_API_KEY,
            api_base=config.GATEWAY_URL,
            max_tokens=4096,
        )
    else:
        raise ValueError(
            f"Unknown EXTRACTION_PROVIDER: {config.EXTRACTION_PROVIDER}"
        )


_configure_llamaindex()


# ============================================================================
# STEP 1: CHUNKING AND EMBEDDING
# ============================================================================

_DEFAULT_CHUNK_SIZE = 1024
_DEFAULT_CHUNK_OVERLAP = 200


def _build_splitter() -> SentenceSplitter:
    return SentenceSplitter(
        chunk_size=_DEFAULT_CHUNK_SIZE,
        chunk_overlap=_DEFAULT_CHUNK_OVERLAP,
        paragraph_separator="\n\n",
    )


def chunk_and_embed(
    text: str,
    stack_id: UUID,
    document_id: UUID,
) -> list[ChunkResult]:
    """
    Split text into chunks and compute embeddings for each.
    One batched HTTP call to the embeddings endpoint.
    """
    if not text.strip():
        return []

    splitter = _build_splitter()
    nodes: list[TextNode] = splitter.get_nodes_from_documents([
        Document(text=text)
    ])
    if not nodes:
        return []

    texts = [n.text for n in nodes]
    embeddings = Settings.embed_model.get_text_embedding_batch(
        texts,
        show_progress=False,
    )

    results: list[ChunkResult] = []
    for i, (node, emb) in enumerate(zip(nodes, embeddings)):
        content = node.text
        results.append(ChunkResult(
            document_id=document_id,
            stack_id=stack_id,
            chunk_index=i,
            content=content,
            content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            token_count=_count_tokens(content),
            embedding=emb,
            chunker_strategy="sentence",
        ))
    return results


def embed_query(text: str) -> list[float]:
    """
    Embed a single query string. Used by the /context endpoint.
    Same model as document chunks, so cosine distances are comparable.
    """
    return Settings.embed_model.get_text_embedding(text)


def _count_tokens(text: str) -> int:
    """Approximate token count using tiktoken's cl100k_base encoder."""
    import tiktoken
    enc = tiktoken.get_encoding("cl100k_base")
    return len(enc.encode(text))


# ============================================================================
# STEP 2: GRAPH EXTRACTION
# ============================================================================

def extract_graph_from_chunks(
    chunks: list[ChunkResult],
    stack_name: str,
) -> ExtractionResult:
    """
    Run the LLM extractor across all chunks and merge the results.
    Name-deduplicates entities and (from, type, to)-deduplicates relationships.
    """
    if not chunks:
        return ExtractionResult(
            entities=[],
            relationships=[],
            model=config.EXTRACTION_MODEL,
        )

    extractor = SchemaLLMPathExtractor(
        llm=Settings.llm,
        possible_entities=None,
        possible_relations=None,
        kg_validation_schema=None,
        strict=False,
        max_triplets_per_chunk=20,
        num_workers=4,
    )

    nodes: list[TextNode] = []
    for chunk in chunks:
        nodes.append(TextNode(
            text=chunk.content,
            metadata={
                "chunk_index": chunk.chunk_index,
                "stack_name": stack_name,
            },
        ))

    annotated = extractor(nodes)

    entity_map: dict[str, ExtractedEntity] = {}
    relationship_list: list[ExtractedRelationship] = []

    for node in annotated:
        chunk_idx = node.metadata.get("chunk_index", -1)

        for ent in _entities_from_node(node):
            key = ent.name.strip().lower()
            if key in entity_map:
                existing = entity_map[key]
                if ent.confidence > existing.confidence:
                    existing.description = ent.description
                    existing.confidence = ent.confidence
                    existing.type = ent.type
                existing.source_chunk_indices.append(chunk_idx)
            else:
                ent.source_chunk_indices = [chunk_idx]
                entity_map[key] = ent

        for rel in _relationships_from_node(node):
            rel.source_chunk_indices = [chunk_idx]
            relationship_list.append(rel)

    rel_map: dict[tuple[str, str, str], ExtractedRelationship] = {}
    for r in relationship_list:
        key = (r.from_entity_name.lower(), r.type.lower(), r.to_entity_name.lower())
        if key in rel_map:
            existing = rel_map[key]
            if r.confidence > existing.confidence:
                existing.description = r.description
                existing.confidence = r.confidence
            existing.source_chunk_indices.extend(r.source_chunk_indices)
        else:
            rel_map[key] = r

    return ExtractionResult(
        entities=list(entity_map.values()),
        relationships=list(rel_map.values()),
        model=config.EXTRACTION_MODEL,
    )


# ============================================================================
# STEP 3: OPTIONAL DESCRIPTION SYNTHESIS
# ============================================================================

def synthesize_entity_descriptions(
    extraction: ExtractionResult,
    chunks: list[ChunkResult],
) -> None:
    """
    Fill in description fields on every entity in the extraction result.
    Mutates extraction in place.

    For each entity, the LLM is given:
      - The entity's name and type
      - All sibling entity names (for domain context)
      - The chunks that contained this entity (for source grounding)

    The result is a 2-4 sentence description that reflects what the
    source documents say AND knows about its siblings in the domain.

    Cost: one LLM call per entity. Roughly $0.01-$0.02 per entity at
    Sonnet rates, plus 2-3 seconds each. A document producing 12
    entities adds ~$0.15 and 30-60 seconds to ingestion.

    This is why it's opt-in. The reference server does not call it
    unless the Stack opts in or the ingest call requests it.
    """
    if not extraction.entities or not chunks:
        return

    chunk_by_index: dict[int, str] = {c.chunk_index: c.content for c in chunks}
    all_entity_names = sorted({e.name for e in extraction.entities})
    domain_context = ", ".join(all_entity_names)

    for entity in extraction.entities:
        relevant_chunks = [
            chunk_by_index[idx]
            for idx in entity.source_chunk_indices
            if idx in chunk_by_index
        ]
        if not relevant_chunks:
            continue

        chunk_text = "\n\n---\n\n".join(relevant_chunks[:3])

        prompt = f"""You are writing a compiled description for one entity in a knowledge graph.

ENTITY: {entity.name}
TYPE: {entity.type}

OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):
{domain_context}

SOURCE PASSAGES THAT MENTION THIS ENTITY:
{chunk_text}

Write a description of this entity that:
- Is 2-4 sentences. Not longer.
- Reflects what the source passages say about this specific entity.
- Naturally references other entities in the domain when relevant.
- Is precise. No filler, no hedging, no "this entity is..." preamble.

Return ONLY the description as plain prose."""

        entity.description = complete(prompt, max_tokens=300)


# ============================================================================
# HELPERS for LlamaIndex metadata extraction
# ============================================================================

def _entities_from_node(node) -> list[ExtractedEntity]:
    """
    Pull entities off an annotated TextNode.

    LlamaIndex v0.12 attaches entities under metadata["nodes"] as
    EntityNode objects with name, label, properties attributes.
    """
    raw_entities = node.metadata.get("nodes", [])
    out: list[ExtractedEntity] = []
    for e in raw_entities:
        name = getattr(e, "name", None)
        label = getattr(e, "label", None)
        if not name:
            continue
        out.append(ExtractedEntity(
            name=name.strip(),
            type=(label or "Concept").strip(),
            description="",  # populated later only if synthesis is enabled
            confidence=0.7,
        ))
    return out


def _relationships_from_node(node) -> list[ExtractedRelationship]:
    """
    Pull relationships off an annotated TextNode.

    LlamaIndex v0.12 attaches relations under metadata["relations"] as
    Relation objects with source_id, target_id, label, properties.
    """
    raw_relations = node.metadata.get("relations", [])
    out: list[ExtractedRelationship] = []
    for r in raw_relations:
        src = getattr(r, "source_id", None)
        tgt = getattr(r, "target_id", None)
        label = getattr(r, "label", None)
        if not (src and tgt and label):
            continue
        out.append(ExtractedRelationship(
            from_entity_name=src.strip(),
            to_entity_name=tgt.strip(),
            type=label.strip().lower().replace(" ", "_"),
            description="",
            confidence=0.7,
        ))
    return out
