"""External-tracker integrations (M5).

A *thin* sync boundary: PromptConnext mirrors only status / assignment / linkage
to an external tracker. The AI-native execution graph (agent runs, artifacts,
spec lineage) stays in PromptConnext — nothing external can hold it.

Direction is decided per field by M3's ownership split: PromptConnext pushes `pz`
fields *out*; the tracker pushes `pmo` fields *in* via a `source="pmo"` upsert,
so inbound writes can only ever touch pmo fields.
"""

from app.integrations.registry import get_adapter, list_providers

__all__ = ["get_adapter", "list_providers"]
