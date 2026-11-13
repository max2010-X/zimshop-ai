import os
import re
import unicodedata

from sqlalchemy import create_engine, select
from sqlalchemy.orm import DeclarativeBase, sessionmaker


DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL or DATABASE_URL.startswith("******"):
    DATABASE_URL = "sqlite:///./zimshop.db"

engine_kwargs = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def normalize_phrase(value: str) -> str:
    text = unicodedata.normalize("NFKD", value.casefold())
    text = text.encode("ascii", "ignore").decode("ascii")
    return " ".join(text.replace("-", " ").replace("_", " ").split())


def _env_term_set() -> set[str]:
    raw = os.getenv("ZIMSHOP_CUSTOM_TERMS", "").strip()
    if not raw:
        return set()
    terms: set[str] = set()
    for chunk in raw.replace(";", "\n").splitlines():
        for item in chunk.split(","):
            cleaned = normalize_phrase(item.strip())
            if cleaned:
                terms.add(cleaned)
    return terms


def load_learned_phrases() -> dict[str, list[str]]:
    phrases: dict[str, list[str]] = {}
    for term in sorted(_env_term_set()):
        phrases.setdefault("General", []).append(term)

    try:
        from .models import BotLearnedPhrase

        with SessionLocal() as session:
            for item in session.scalars(select(BotLearnedPhrase).order_by(BotLearnedPhrase.created_at.desc())).all():
                category = (item.category or "General").strip() or "General"
                phrase = normalize_phrase(item.phrase)
                if phrase:
                    phrases.setdefault(category, [])
                    if phrase not in phrases[category]:
                        phrases[category].append(phrase)
    except Exception:
        return phrases
    return phrases


def remember_learned_phrases(terms: list[str], category: str = "General") -> None:
    if not terms:
        return

    seen: set[str] = set()
    clean_terms: list[str] = []
    for term in terms:
        normalized = normalize_phrase(str(term))
        if normalized and len(normalized) >= 3 and normalized not in seen:
            seen.add(normalized)
            clean_terms.append(normalized)
    if not clean_terms:
        return

    try:
        from .models import BotLearnedPhrase

        with SessionLocal() as session:
            for term in clean_terms:
                label = (category or "General").strip() or "General"
                existing = session.scalar(
                    select(BotLearnedPhrase).where(
                        BotLearnedPhrase.phrase == term,
                        BotLearnedPhrase.category == label,
                    )
                )
                if existing is None:
                    session.add(BotLearnedPhrase(phrase=term, category=label, confidence=60))
                else:
                    existing.confidence = min(100, max(60, existing.confidence + 5))
                    existing.last_seen_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
            session.commit()
    except Exception:
        return


def learn_phrases_from_text(message: str, category: str = "Retail") -> None:
    if not message or not message.strip():
        return
    normalized = normalize_phrase(message)
    if not normalized:
        return
    tokens = [part for part in re.split(r"[^a-z0-9]+", normalized) if part and len(part) >= 3]
    phrases: list[str] = []
    for index in range(len(tokens)):
        for span in range(2, min(4, len(tokens) - index + 1)):
            phrase = " ".join(tokens[index:index + span])
            if len(phrase) >= 6:
                phrases.append(phrase)
    phrases.extend(tokens)
    remember_learned_phrases(phrases, category=category)


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
