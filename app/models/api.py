"""
Pydantic models for API request and response bodies.

One model definition gives FastAPI three behaviors:
  1. Validates incoming JSON against the model
  2. Serializes the model back to JSON for the response
  3. Generates the OpenAPI schema and Swagger docs
"""
from datetime import datetime
from typing import Optional, Literal
from uuid import UUID

from pydantic import BaseModel, Field


# ============================================================
# Stack models (Group 1, extended with synthesize_descriptions in Group 5b)
# ============================================================

class StackCreate(BaseModel):
    """Request body for POST /stacks."""
    name: str = Field(..., min_length=1, max_length=200)
    domain: str = Field(
        ...,
        pattern=r"^[a-z0-9-]+$",
        description="Lowercase hyphenated slug. Must be unique across all Stacks.",
    )
    description: Optional[str] = None
    scope: Literal["stack", "workspace", "domain"] = "stack"
    compilation_strategy: Literal["incremental", "global"] = "incremental"
    synthesize_descriptions: bool = False


class StackUpdate(BaseModel):
    """Request body for PATCH /stacks/{id}. All fields optional."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    scope: Optional[Literal["stack", "workspace", "domain"]] = None
    compilation_strategy: Optional[Literal["incremental", "global"]] = None
    synthesize_descriptions: Optional[bool] = None


class StackResponse(BaseModel):
    """Response shape for all Stack endpoints. Mirrors the stacks table."""
    id: UUID
    name: str
    domain: str
    description: Optional[str]
    scope: str
    compilation_strategy: str
    synthesize_descriptions: bool
    created_at: datetime
    updated_at: datetime


# ============================================================
# Document models (Group 2)
# ============================================================

class DocumentResponse(BaseModel):
    id: UUID
    stack_id: UUID
    filename: str
    size_bytes: int
    content_type: Optional[str]
    source_hash: str
    truncated: bool
    original_length: Optional[int]
    ingested_at: datetime
    audit: Optional[dict] = None


# ============================================================
# AKS endpoint models (Group 4)
# ============================================================

class AKSSource(BaseModel):
    """Traceability block on every entity and relationship."""
    document_id: Optional[UUID] = None
    connector_id: Optional[UUID] = None
    source_kind: Optional[str] = None
    extracted_at: Optional[datetime] = None
    model: Optional[str] = None
    verified: bool = False
    pipeline: Optional[str] = None


class AKSEntity(BaseModel):
    """An entity as it appears in AKS Bundle exports and query responses."""
    id: UUID
    name: str
    type: str
    description: Optional[str] = None
    properties: dict = {}
    confidence: float
    contributing_documents: list[UUID] = []
    last_seen_at: Optional[datetime] = None
    source: AKSSource


class AKSRelationship(BaseModel):
    """A relationship as it appears in AKS Bundle exports and query responses."""
    id: UUID
    from_entity_id: UUID
    to_entity_id: UUID
    type: str
    description: Optional[str] = None
    confidence: float
    source: AKSSource


class AKSContextRequest(BaseModel):
    """Request body for POST /aks/v1/context."""
    query: str = Field(..., min_length=1)
    stack_id: Optional[UUID] = None
    domain: Optional[str] = None
    max_entities: int = Field(default=8, ge=1, le=50)
    include_relationships: bool = True


class AKSContextResponse(BaseModel):
    """Response from POST /aks/v1/context."""
    query: str
    entities: list[AKSEntity]
    relationships: list[AKSRelationship]
    traversal_path: list[str]
    reasoning: str
    confidence: Literal["HIGH", "MEDIUM", "LOW"]
    source_type: Literal["compiled", "live", "hybrid"] = "compiled"


class AKSTraverseStep(BaseModel):
    """One step in a traversal result."""
    from_entity: str
    relationship: str
    to_entity: str
    depth: int
    confidence: float


class AKSTraverseResponse(BaseModel):
    """Response from GET /aks/v1/traverse."""
    start: str
    max_depth: int
    steps: list[AKSTraverseStep]
    entity_count: int


class AKSDocumentSummary(BaseModel):
    """AKSDocument as it appears in a Bundle export."""
    id: UUID
    filename: str
    ingested_at: datetime
    source_hash: str
    truncated: bool
    original_length: Optional[int] = None
    audit: Optional[dict] = None


class AKSBundle(BaseModel):
    """The full AKS Bundle export shape."""
    aks_version: str = "0.2.0"
    domain: str
    stack_id: UUID
    stack_name: str
    compiled_at: datetime
    scope: str
    entity_count: int
    relationship_count: int
    document_count: int = 0
    compilation_strategy: Optional[str] = None
    documents: list[AKSDocumentSummary] = []
    entities: list[AKSEntity] = []
    relationships: list[AKSRelationship] = []


# ============================================================
# Entity page models (Group 5)
# ============================================================

class AKSEntityPage(BaseModel):
    """A single generated entity page."""
    entity_name: str
    markdown: str
    generated_at: datetime
    source_entity_id: UUID
    graph_version: str
    source_type: str = "compiled"
    cached: Optional[bool] = None

# ============================================================
# Backfeed models (Group 6)
# ============================================================

class BackfeedEntityProposal(BaseModel):
    """A proposed entity inside a backfeed item."""
    name: str
    type: str
    description: Optional[str] = None
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    properties: dict = {}


class BackfeedRelationshipProposal(BaseModel):
    """A proposed relationship inside a backfeed item."""
    from_entity: str = Field(..., description="From-entity name")
    to_entity: str = Field(..., description="To-entity name")
    type: str
    description: Optional[str] = None
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)


class BackfeedProposal(BaseModel):
    """The structured payload of a backfeed item."""
    entities: list[BackfeedEntityProposal] = []
    relationships: list[BackfeedRelationshipProposal] = []


class BackfeedFlagRequest(BaseModel):
    """Request body for POST /aks/v1/backfeed/flag."""
    stack_id: Optional[UUID] = None
    domain: Optional[str] = None
    origin: Literal["run", "direct"] = "direct"
    trigger_type: Literal["manual", "auto", "api"] = "manual"
    proposal: BackfeedProposal
    note: Optional[str] = None
    metadata: dict = {}


class BackfeedItemResponse(BaseModel):
    """A backfeed queue item as returned by the API."""
    id: UUID
    stack_id: UUID
    origin: str
    trigger_type: str
    proposal: BackfeedProposal
    note: Optional[str]
    metadata: dict
    status: str
    reviewed_at: Optional[datetime]
    reviewed_by: Optional[str]
    review_note: Optional[str]
    created_at: datetime


class BackfeedApprovalRequest(BaseModel):
    """Request body for POST /aks/v1/backfeed/approve."""
    item_id: UUID
    reviewed_by: Optional[str] = None
    review_note: Optional[str] = None


class BackfeedApprovalResult(BaseModel):
    """Result of approving a backfeed item."""
    item_id: UUID
    entities_absorbed: int
    relationships_absorbed: int
    status: str  # always "approved" on success


class BackfeedRejectionRequest(BaseModel):
    """Request body for POST /aks/v1/backfeed/reject."""
    item_id: UUID
    reviewed_by: Optional[str] = None
    review_note: Optional[str] = None