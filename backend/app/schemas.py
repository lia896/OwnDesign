"""Request schemas. Geometry is the canonical 2D plan: centimetres, origin top-left, y down."""

import math
from typing import Annotated, Literal
from uuid import UUID

from app.catalog import MATERIALS_BY_ID, STYLE_IDS
from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, model_validator

MAX_COORD_CM = 100_000  # 1 km: far beyond any residential plan
MAX_ITEMS = 1000

Id = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,40}$")]
Cm = Annotated[float, Field(ge=-MAX_COORD_CM, le=MAX_COORD_CM, allow_inf_nan=False)]
Size = Annotated[float, Field(gt=0, le=MAX_COORD_CM, allow_inf_nan=False)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class Room(Strict):
    id: Id
    name: Name
    type: Annotated[str, StringConstraints(max_length=30)]


class Wall(Strict):
    id: Id
    x1: Cm
    y1: Cm
    x2: Cm
    y2: Cm
    thickness: Annotated[float, Field(gt=0, le=100, allow_inf_nan=False)]
    kind: Literal["exterior", "partition"]
    roomId: Id | None = None

    @property
    def length(self) -> float:
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)

    @model_validator(mode="after")
    def _non_zero_length(self):
        if self.length < 1:
            raise ValueError("wall must be at least 1 cm long")
        return self


class Opening(Strict):
    id: Id
    wallId: Id
    type: Literal["door", "window"]
    offset: Annotated[float, Field(ge=0, le=MAX_COORD_CM, allow_inf_nan=False)]  # from wall start to opening start
    width: Size


class Furniture(Strict):
    id: Id
    type: Annotated[str, StringConstraints(pattern=r"^[a-z0-9_-]{1,40}$")]
    x: Cm
    y: Cm
    w: Size
    d: Size
    rotation: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)]


class Geometry(Strict):
    schema_version: Literal[1] = Field(alias="schema")
    units: Literal["cm"]
    rooms: Annotated[list[Room], Field(max_length=100)]
    walls: Annotated[list[Wall], Field(max_length=MAX_ITEMS)]
    openings: Annotated[list[Opening], Field(max_length=MAX_ITEMS)]
    furniture: Annotated[list[Furniture], Field(max_length=MAX_ITEMS)]

    @model_validator(mode="after")
    def _references_are_consistent(self):
        for items in (self.rooms, self.walls, self.openings, self.furniture):
            ids = [item.id for item in items]
            if len(ids) != len(set(ids)):
                raise ValueError("duplicate id")
        room_ids = {room.id for room in self.rooms}
        walls = {wall.id: wall for wall in self.walls}
        for wall in self.walls:
            if wall.roomId is not None and wall.roomId not in room_ids:
                raise ValueError(f"wall {wall.id} references unknown room")
        for opening in self.openings:
            wall = walls.get(opening.wallId)
            if wall is None:
                raise ValueError(f"opening {opening.id} references unknown wall")
            if opening.offset + opening.width > wall.length + 0.01:
                raise ValueError(f"opening {opening.id} does not fit in its wall")
        return self


class StudioCreate(Strict):
    name: Name


class InviteCreate(Strict):
    client_email: EmailStr
    client_name: Name


class ProjectCreate(Strict):
    studio_id: UUID
    name: Name
    property_type: Literal["existing", "new_build"]


class CompareBody(Strict):
    version_a_id: UUID  # baseline
    version_b_id: UUID  # compared against the baseline


class VersionCreate(Strict):
    label: Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)] = ""
    geometry: Geometry


Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]
Hex = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]
Money = Annotated[int, Field(ge=0, le=100_000_000)]


class Brief(Strict):
    """The design brief (PRD FR-04): style, colours, budget, household, needs, constraints, existing items."""

    styles: Annotated[list[str], Field(max_length=5)] = []
    colors: Annotated[list[Hex], Field(max_length=8)] = []
    budget_min: Money | None = None
    budget_max: Money | None = None
    currency: Literal["USD", "EUR", "GBP", "ILS"] = "USD"
    adults: Annotated[int, Field(ge=0, le=20)] = 1
    children: Annotated[int, Field(ge=0, le=20)] = 0
    pets: bool = False
    lifestyle: Text = ""
    needs: Text = ""
    constraints: Text = ""
    existing_items: Text = ""

    @model_validator(mode="after")
    def _consistent(self):
        unknown = [style for style in self.styles if style not in STYLE_IDS]
        if unknown or len(set(self.styles)) != len(self.styles):
            raise ValueError("styles must be distinct and from the catalog")
        if len(set(self.colors)) != len(self.colors):
            raise ValueError("colors must be distinct")
        if self.budget_min is not None and self.budget_max is not None and self.budget_min > self.budget_max:
            raise ValueError("budget_min must not exceed budget_max")
        return self


class FinishSelection(Strict):
    room_id: Id
    surface: Literal["floor", "walls", "ceiling", "cabinets"]
    material_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{1,40}$")]

    @model_validator(mode="after")
    def _material_fits_surface(self):
        material = MATERIALS_BY_ID.get(self.material_id)
        if material is None or self.surface not in material["surfaces"]:
            raise ValueError("unknown material, or it cannot be applied to this surface")
        return self


class FinishesBody(Strict):
    selections: Annotated[list[FinishSelection], Field(max_length=400)]

    @model_validator(mode="after")
    def _one_per_surface(self):
        keys = [(item.room_id, item.surface) for item in self.selections]
        if len(keys) != len(set(keys)):
            raise ValueError("one material per room surface")
        return self


class MoodboardItem(Strict):
    kind: Literal["asset", "style", "material"]
    ref: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""

    @model_validator(mode="after")
    def _ref_is_known(self):
        if self.kind == "style" and self.ref not in STYLE_IDS:
            raise ValueError("unknown style")
        if self.kind == "material" and self.ref not in MATERIALS_BY_ID:
            raise ValueError("unknown material")
        if self.kind == "asset":
            UUID(self.ref)  # an asset is referenced by its id; ownership is checked in the route
        return self


class MoodboardBody(Strict):
    items: Annotated[list[MoodboardItem], Field(max_length=40)]

    @model_validator(mode="after")
    def _distinct(self):
        keys = [(item.kind, item.ref) for item in self.items]
        if len(keys) != len(set(keys)):
            raise ValueError("an item can appear once on the board")
        return self
