from pydantic import BaseModel, Field


class TodoPayload(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    date: str
    due_time: str = ""
    source_template_id: str = ""
    preferred_block_minutes: int = 45
    preferred_block_color: str = "slate"
    priority: str = "medium"
    notes: str = ""
    completed: bool = False


class TodoPatchPayload(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    date: str | None = None
    due_time: str | None = None
    source_template_id: str | None = None
    preferred_block_minutes: int | None = None
    preferred_block_color: str | None = None
    priority: str | None = None
    notes: str | None = None
    completed: bool | None = None


class EventPayload(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    date: str = ""
    start_time: str = ""
    end_time: str = ""
    color: str = "teal"
    notes: str = ""
    source_todo_id: str = ""
    event_type: str = "interval"
    repeat_rule: str = "none"
    repeat_weekdays: list[str] = Field(default_factory=list)


class EventPatchPayload(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    date: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    color: str | None = None
    notes: str | None = None
    source_todo_id: str | None = None
    event_type: str | None = None
    repeat_rule: str | None = None
    repeat_weekdays: list[str] | None = None


class TemplatePayload(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    due_time: str = ""
    priority: str = "medium"
    notes: str = ""
    weekdays: list[str] = Field(default_factory=list)
    default_block_minutes: int = 45
    default_block_color: str = "slate"


class TemplatePatchPayload(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    due_time: str | None = None
    priority: str | None = None
    notes: str | None = None
    weekdays: list[str] | None = None
    default_block_minutes: int | None = None
    default_block_color: str | None = None


class BoardPayload(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = ""
    color: str = "slate"


class BoardPatchPayload(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    color: str | None = None


class LanePayload(BaseModel):
    board_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=80)
    position: int | None = None


class LanePatchPayload(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=80)
    position: int | None = None


class LaneMovePayload(BaseModel):
    position: int


class LaneArchivePayload(BaseModel):
    archived: bool = True


class CardChecklistItemPayload(BaseModel):
    id: str = ""
    text: str = Field(min_length=1, max_length=120)
    done: bool = False


class CardPayload(BaseModel):
    board_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=160)
    description: str = ""
    labels: list[str] = Field(default_factory=list)
    members: list[str] = Field(default_factory=list)
    checklist: list[CardChecklistItemPayload] = Field(default_factory=list)
    due_date: str = ""
    color: str = "slate"
    event_type: str = "none"
    date: str = ""
    repeat_end_date: str = ""
    start_time: str = ""
    end_time: str = ""
    repeat_rule: str = "none"
    repeat_weekdays: list[str] = Field(default_factory=list)
    archived: bool = False
    position: int | None = None


class CardPatchPayload(BaseModel):
    board_id: str | None = None
    lane_id: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = None
    labels: list[str] | None = None
    members: list[str] | None = None
    checklist: list[CardChecklistItemPayload] | None = None
    due_date: str | None = None
    color: str | None = None
    event_type: str | None = None
    date: str | None = None
    repeat_end_date: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    repeat_rule: str | None = None
    repeat_weekdays: list[str] | None = None
    archived: bool | None = None
    position: int | None = None


class CardMovePayload(BaseModel):
    lane_id: str = Field(min_length=1)
    position: int | None = None
    before_card_id: str | None = None
    after_card_id: str | None = None
