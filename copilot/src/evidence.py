import re
from dataclasses import dataclass

import chromadb


@dataclass
class EvidenceChunk:
    text: str
    source: str


_COLLECTION_NAME = "copilot_evidence"


class EvidenceIndex:
    def __init__(self) -> None:
        self._client = chromadb.EphemeralClient()
        existing = {collection.name for collection in self._client.list_collections()}
        if _COLLECTION_NAME in existing:
            self._client.delete_collection(_COLLECTION_NAME)
        self._collection = self._client.create_collection(
            name=_COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        self._chunks: list[EvidenceChunk] = []

    def _split(self, text: str, source: str) -> list[EvidenceChunk]:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not paragraphs:
            paragraphs = [text.strip()] if text.strip() else []
        chunks: list[EvidenceChunk] = []
        for para in paragraphs:
            if len(para) <= 800:
                chunks.append(EvidenceChunk(text=para, source=source))
                continue
            sentences = re.split(r"(?<=[.!?])\s+", para)
            buf = ""
            for sentence in sentences:
                if len(buf) + len(sentence) > 800 and buf:
                    chunks.append(EvidenceChunk(text=buf.strip(), source=source))
                    buf = sentence
                else:
                    buf = f"{buf} {sentence}".strip()
            if buf:
                chunks.append(EvidenceChunk(text=buf.strip(), source=source))
        return chunks

    def index(
        self,
        *,
        resume_text: str,
        knowledge_text: str,
        profile: dict,
        duty_statement_text: str = "",
        company_context: str = "",
    ) -> None:
        profile_blob = "\n".join(
            [
                f"Name: {profile.get('first_name', '')} {profile.get('last_name', '')}",
                f"Location: {profile.get('location', '')}",
                f"Summary: {profile.get('summary', '')}",
                f"Skills: {', '.join(profile.get('skills', []))}",
                f"Target roles: {', '.join(profile.get('target_role_themes', []))}",
            ]
        )
        sources: list[tuple[str, str]] = [
            ("resume", resume_text),
            ("knowledge_base", knowledge_text),
            ("profile", profile_blob),
        ]
        if duty_statement_text.strip():
            sources.append(("duty_statement", duty_statement_text))
        if company_context.strip():
            sources.append(("company_context", company_context.strip()))
        for source, text in sources:
            if not text.strip():
                continue
            self._chunks.extend(self._split(text, source))

        if not self._chunks:
            raise ValueError("Evidence index is empty. Resume and knowledge base have no indexable text.")

        self._collection.add(
            ids=[f"chunk_{i}" for i in range(len(self._chunks))],
            documents=[c.text for c in self._chunks],
            metadatas=[{"source": c.source} for c in self._chunks],
        )

    @property
    def chunk_count(self) -> int:
        return len(self._chunks)

    def retrieve(self, query: str, n: int = 3) -> list[EvidenceChunk]:
        if not self._chunks:
            return []
        result = self._collection.query(query_texts=[query], n_results=min(n, len(self._chunks)))
        docs = result.get("documents", [[]])[0]
        metas = result.get("metadatas", [[]])[0]
        return [
            EvidenceChunk(text=doc, source=meta.get("source", "unknown"))
            for doc, meta in zip(docs, metas)
        ]

    def evidence_block(self, queries: list[str], per_query: int = 2) -> str:
        seen: set[str] = set()
        lines: list[str] = []
        for query in queries:
            for chunk in self.retrieve(query, n=per_query):
                key = chunk.text[:80]
                if key in seen:
                    continue
                seen.add(key)
                lines.append(f"[{chunk.source}] {chunk.text}")
        return "\n".join(lines)
