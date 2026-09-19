"""Shared low-level helpers for workspace database domain modules."""


def meta_value(db, key: str):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row is not None else None


def set_meta(db, key: str, value) -> None:
    db.execute(
        """INSERT INTO meta(key,value) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
        (key, str(value)),
    )
