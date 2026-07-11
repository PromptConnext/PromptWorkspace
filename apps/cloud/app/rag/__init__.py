"""RAG assistant v1 (plan 0005 M9): chunk, embed, retrieve, chat.

Embedding always runs off the request path (app/rag/queue.py) — the sync
upsert in app/api/sync.py only enqueues; the background worker in app/main.py
does the actual model calls, per ADR 0011's "never block an upsert on an
embedding call."
"""
