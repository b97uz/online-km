from __future__ import annotations

import re


_MATCH_RE = re.compile(r"(\d{1,3})([A-D])")


class ParseError(ValueError):
    pass



def parse_answer_text(raw_text: str, total_questions: int) -> dict:
    raw = (raw_text or "").upper()
    raw = re.sub(r"\s+", "", raw)

    if len(raw) < 2 or len(raw) > 3000:
        raise ParseError("Javob formati noto'g'ri. Masalan: 1A2B3C")

    by_question = [""] * total_questions
    parsed: list[dict] = []
    seen: set[int] = set()

    for m in _MATCH_RE.finditer(raw):
        question_number = int(m.group(1))
        answer = m.group(2)

        if question_number < 1 or question_number > total_questions:
            continue
        if question_number in seen:
            continue

        seen.add(question_number)
        parsed.append({"questionNumber": question_number, "answer": answer})
        by_question[question_number - 1] = answer

    if not parsed:
        raise ParseError("Javob formati noto'g'ri. Masalan: 1A2B3C")

    return {"parsed": parsed, "byQuestion": by_question}
