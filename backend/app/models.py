from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class StatusUpdate(BaseModel):
    status: Literal["fait", "absent", "refus", None] = None
    note: str | None = None
