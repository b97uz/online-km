from __future__ import annotations

from aiogram.types import KeyboardButton, ReplyKeyboardMarkup

from .constants import (
    PARENT_BTN_APPEAL,
    PARENT_BTN_DEBT,
    PARENT_BTN_RESULTS,
    STUDENT_BTN_APPEAL,
    STUDENT_BTN_PAY,
    STUDENT_BTN_RESULTS,
    STUDENT_BTN_TEST,
)



def phone_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Telefon raqamni yuborish", request_contact=True)]],
        resize_keyboard=True,
    )



def student_menu_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=STUDENT_BTN_TEST), KeyboardButton(text=STUDENT_BTN_PAY)],
            [KeyboardButton(text=STUDENT_BTN_RESULTS), KeyboardButton(text=STUDENT_BTN_APPEAL)],
        ],
        resize_keyboard=True,
    )



def parent_menu_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=PARENT_BTN_RESULTS), KeyboardButton(text=PARENT_BTN_DEBT)],
            [KeyboardButton(text=PARENT_BTN_APPEAL)],
        ],
        resize_keyboard=True,
    )
