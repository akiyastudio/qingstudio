"""Shared JSON-lines protocol used by Python tools hosted by Electron."""

from __future__ import annotations

import json


def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None:
        payload["data"] = data
    if progress is not None:
        payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def log_info(message):
    emit("log", message)


def log_success(message, data=None):
    emit("success", message, data=data)


def log_error(message):
    emit("error", message)


def log_warning(message, data=None):
    emit("warning", message, data=data)


def log_progress(message, percent, data=None):
    emit("progress", message, data=data, progress=percent)


def log_status(message, data=None):
    emit("status", message, data=data)


def ask_user(message, data=None):
    emit("ask_user", message, data=data)
