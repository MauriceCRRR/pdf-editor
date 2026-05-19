from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


class UploadResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    document_id: str = Field(alias="documentId", serialization_alias="documentId")
    page_count: int = Field(alias="pageCount", serialization_alias="pageCount")
    filename: str


class FontEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str
    psName: str
    subsetTag: str | None
    baseName: str
    format: str | None
    url: str | None
    bold: bool
    italic: bool
    fallbackFamily: str
    masterUrl: str | None = None
    masterPsName: str | None = None
    masterFamily: str | None = None
    availableCodepoints: list[int] = []
    matchedBy: str | None = None
    fsType: int | None = None
    fsTypeLabel: Literal["installable", "restricted", "preview", "editable"] | None = None


class Span(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    fontPsName: str
    fontRef: str | None
    size: float
    colorRgb: list[float]
    bold: bool
    italic: bool


class Fragment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    bbox: list[float]
    text: str
    spans: list[Span]
    rotation: float = 0.0
    writingMode: Literal["horizontal-tb", "vertical-rl", "vertical-lr"] = "horizontal-tb"
    isFormField: bool = False
    formFieldType: Literal[
        "button", "checkbox", "combobox", "listbox", "radio", "signature", "text"
    ] | None = None
    formFieldName: str | None = None
    isFromXObject: bool = False


class PageData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    widthPt: float
    heightPt: float
    rotation: int
    fragments: list[Fragment]
    appearsScanned: bool = False
    invisibleTextRatio: float = 0.0
    imageCoverageRatio: float = 0.0


class DocumentMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documentId: str
    filename: str
    pageCount: int
    fonts: list[FontEntry]
    pages: list[PageData]


class SpanDelta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    fontRef: str | None = None
    size: float = Field(gt=0)
    colorRgb: tuple[float, float, float] = (0.0, 0.0, 0.0)
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strikethrough: bool = False


class EditDelta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fragId: str
    pageIndex: int = Field(ge=0)
    originalBBox: tuple[float, float, float, float]
    newBBox: tuple[float, float, float, float]
    newText: str
    fontRef: str | None
    size: float = Field(gt=0)
    colorRgb: tuple[float, float, float]
    bold: bool
    italic: bool
    underline: bool
    strikethrough: bool
    align: Literal["left", "center", "right", "justify"]
    # Optional per-span styling. When present and length > 1, the backend
    # renders via TextWriter instead of insert_textbox. newText is still
    # populated by the client for backward compat.
    newSpans: list[SpanDelta] | None = None


class TextInsertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["text"]
    pageIndex: int = Field(ge=0)
    bbox: tuple[float, float, float, float]
    text: str
    fontKey: str
    size: float = Field(gt=0)
    colorRgb: tuple[float, float, float]
    bold: bool
    italic: bool
    underline: bool
    strikethrough: bool
    align: Literal["left", "center", "right", "justify"]


class ShapeInsertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["rectangle", "ellipse"]
    pageIndex: int = Field(ge=0)
    bbox: tuple[float, float, float, float]
    strokeRgb: tuple[float, float, float] | None
    fillRgb: tuple[float, float, float] | None
    strokeWidth: float = Field(ge=0)


class LineInsertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["line", "arrow"]
    pageIndex: int = Field(ge=0)
    fromPt: tuple[float, float]
    toPt: tuple[float, float]
    strokeRgb: tuple[float, float, float]
    strokeWidth: float = Field(gt=0)


class ImageInsertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["image"]
    pageIndex: int = Field(ge=0)
    bbox: tuple[float, float, float, float]
    imageRef: str


Insertion = Annotated[
    Union[TextInsertion, ShapeInsertion, LineInsertion, ImageInsertion],
    Field(discriminator="type"),
]


class SaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edits: list[EditDelta] = Field(default_factory=list)
    insertions: list[Insertion] = Field(default_factory=list)

    @model_validator(mode="after")
    def at_least_one(self) -> "SaveRequest":
        if not self.edits and not self.insertions:
            raise ValueError("must include at least one edit or insertion")
        return self


class ImageUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    imageRef: str
    url: str
    widthPx: int
    heightPx: int


class SaveWarning(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fragId: str | None = None
    insertionId: str | None = None
    pageIndex: int
    code: Literal[
        "text_overflow",
        "ocr_layer",
        "form_field",
        "xobject_shared",
        "rotation_lost",
        "vertical_lost",
    ]
    message: str


class SaveResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document: DocumentMetadata
    warnings: list[SaveWarning] = []
