"""Stable JSON protocol error codes for Python SQLite workers."""

import sqlite3


def database_error_code(error: Exception) -> str:
    explicit_code = getattr(error, "code", None)
    if isinstance(explicit_code, str) and explicit_code:
        return explicit_code
    if isinstance(error, sqlite3.Error):
        primary = int(getattr(error, "sqlite_errorcode", 0) or 0) & 0xFF
        if primary == sqlite3.SQLITE_BUSY:
            return "SQLITE_BUSY"
        if primary == sqlite3.SQLITE_LOCKED:
            return "SQLITE_LOCKED"
        if primary == sqlite3.SQLITE_CONSTRAINT:
            return "SQLITE_CONSTRAINT"
        if primary == sqlite3.SQLITE_READONLY:
            return "SQLITE_READONLY"
        if primary == sqlite3.SQLITE_CORRUPT:
            return "SQLITE_CORRUPT"
        if primary == sqlite3.SQLITE_IOERR:
            return "SQLITE_IOERR"
        return "SQLITE_ERROR"
    if isinstance(error, ValueError):
        return "INVALID_DATABASE_OPERATION"
    return "DATABASE_WORKER_ERROR"


def error_response(request_id, error: Exception) -> dict:
    return {
        "id": request_id,
        "success": False,
        "code": database_error_code(error),
        "error": str(error),
    }
