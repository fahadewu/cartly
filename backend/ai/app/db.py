"""Async Postgres pool (psycopg 3) + the `ai` schema this service owns.

Commerce tables in `public` belong to Prisma and are only ever read here.
"""
from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

DIM = 384
pool: AsyncConnectionPool | None = None


async def _configure(conn: AsyncConnection) -> None:
    await register_vector_async(conn)


async def init_schema() -> None:
    # Extension must exist before connections can register the vector type.
    async with await AsyncConnection.connect(settings.database_url, autocommit=True) as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.execute("CREATE SCHEMA IF NOT EXISTS ai")
        await conn.execute(
            f"""CREATE TABLE IF NOT EXISTS ai.product_embeddings (
                product_id integer PRIMARY KEY,
                embedding  vector({DIM}) NOT NULL,
                content    text NOT NULL,
                model      text NOT NULL DEFAULT 'hashing',
                updated_at timestamptz NOT NULL DEFAULT now()
            )"""
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS product_embeddings_hnsw "
            "ON ai.product_embeddings USING hnsw (embedding vector_cosine_ops)"
        )


async def open_pool() -> AsyncConnectionPool:
    global pool
    if pool is None:
        await init_schema()
        pool = AsyncConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=10,
            # statement_timeout: a stalled query gives up well inside the API gateway's 45 s chat budget.
            kwargs={"row_factory": dict_row, "autocommit": True, "options": "-c statement_timeout=15000"},
            configure=_configure,
            open=False,
        )
        await pool.open(wait=True, timeout=10)
    return pool


async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None


async def fetch(sql: str, params=None) -> list[dict]:
    p = await open_pool()
    async with p.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()
