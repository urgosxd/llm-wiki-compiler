"""
Project-wide constants.
"""

# Maximum character count for text content before extraction truncation.
# Documents larger than this are stored in full on disk; the extraction
# pipeline (Group 3) will truncate the text it sends to the LLM.
# 500K chars is well within Claude Sonnet's context window with room
# left over for the extraction prompt.
MAX_EXTRACTION_CHARS = 500_000

# Hard upper bound on a single uploaded file. Prevents accidental 1GB
# uploads exhausting server memory.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

# Storage directory for uploaded files, relative to the container working dir.
# Matches the volume mount in docker-compose.yml.
UPLOAD_DIR = "uploads"