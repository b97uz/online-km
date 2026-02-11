from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.answer_parser import parse_answer_text  # noqa: E402


def assert_contains(path: Path, needle: str) -> None:
    data = path.read_text(encoding="utf-8")
    if needle not in data:
        raise AssertionError(f"{path.name}: '{needle}' topilmadi")


def check_handler_mapping() -> None:
    assert_contains(ROOT / "routers" / "commands.py", 'Command("start")')
    assert_contains(ROOT / "routers" / "commands.py", 'Command("ping")')
    assert_contains(ROOT / "routers" / "contacts.py", "@router.message(F.contact)")
    assert_contains(ROOT / "routers" / "callbacks.py", 'F.data.startswith("open_test:")')
    assert_contains(ROOT / "routers" / "messages.py", "@router.message(F.text)")


def check_db_submission_sql() -> None:
    repo_path = ROOT / "db" / "repository.py"
    assert_contains(repo_path, 'INSERT INTO "Submission"')
    assert_contains(repo_path, 'INSERT INTO "SubmissionDetail"')
    assert_contains(repo_path, 'UPDATE "AccessWindow"')


def check_answer_parser() -> None:
    parsed = parse_answer_text("1a 2b3c", 3)
    assert parsed["byQuestion"] == ["A", "B", "C"]
    assert len(parsed["parsed"]) == 3


def main() -> None:
    check_handler_mapping()
    check_db_submission_sql()
    check_answer_parser()
    print("SMOKE_OK: handler mapping + DB submit SQL + answer parser")


if __name__ == "__main__":
    main()
