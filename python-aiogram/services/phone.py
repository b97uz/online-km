from __future__ import annotations

import re


_DIGIT_RE = re.compile(r"\D+")


def normalize_uz_phone(raw: str) -> str:
    digits = _DIGIT_RE.sub("", raw or "")
    if not digits:
        return ""

    if len(digits) == 9:
        return f"+998{digits}"
    if len(digits) == 12 and digits.startswith("998"):
        return f"+{digits}"
    if raw.strip().startswith("+"):
        return f"+{digits}"
    return f"+{digits}"


def phone_variants(raw: str) -> list[str]:
    normalized = normalize_uz_phone(raw)
    if not normalized:
        return []
    variants = {normalized, normalized.lstrip("+")}
    return list(variants)


def is_uz_e164(phone: str) -> bool:
    return bool(re.fullmatch(r"\+998\d{9}", phone or ""))
