from __future__ import annotations

from datetime import date, datetime, timedelta



def format_date(value: datetime) -> str:
    return value.strftime("%d.%m.%Y %H:%M")



def format_date_only(value: date | datetime) -> str:
    if isinstance(value, datetime):
        return value.strftime("%d.%m.%Y")
    return value.strftime("%d.%m.%Y")



def format_attendance(attendance: str) -> str:
    if attendance == "PRESENT":
        return "Keldi ✅"
    if attendance == "ABSENT":
        return "Kelmadi ❌"
    return "Sababli 🟡"



def format_money(amount: int) -> str:
    return format(int(amount), ",").replace(",", " ")



def add_months_keeping_day(value: date, months: int) -> date:
    year = value.year
    month = value.month
    day = value.day

    target_idx = (month - 1) + months
    target_year = year + (target_idx // 12)
    target_month = (target_idx % 12) + 1

    # Last day of target month
    if target_month == 12:
        next_month = date(target_year + 1, 1, 1)
    else:
        next_month = date(target_year, target_month + 1, 1)
    last_day = (next_month - timedelta(days=1)).day

    return date(target_year, target_month, min(day, last_day))
