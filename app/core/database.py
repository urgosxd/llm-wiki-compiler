"""
Database connection management.

FastAPI uses a dependency-injection pattern: routes declare what they need
via Depends(...), and FastAPI is responsible for creating those resources
and cleaning them up. `get_db` is the database-connection dependency that
every route touching Postgres will use.
"""
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.extensions import connection as PGConnection
from typing import Generator

from app.core.config import config


def get_connection() -> PGConnection:
    """
    Create a single Postgres connection.

    cursor_factory=RealDictCursor makes query results come back as dicts
    (keyed by column name) instead of tuples. That means row["id"] works
    instead of row[0], which is dramatically more readable.
    """
    return psycopg2.connect(config.DATABASE_URL, cursor_factory=RealDictCursor)


def get_db() -> Generator[PGConnection, None, None]:
    """
    FastAPI dependency that provides a database connection for one request.

    This is a Python generator function. FastAPI knows the convention:
      - the value before `yield` is given to the route
      - everything after `yield` runs after the route returns (cleanup)

    Transaction handling is automatic:
      - route returns normally → commit
      - route raises an exception → rollback
      - either way → close the connection

    Usage in a route:

        @router.get("/something")
        def handler(conn = Depends(get_db)):
            with conn.cursor() as cur:
                cur.execute("select ...")

    Every request gets its own connection. They never leak.
    """
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()