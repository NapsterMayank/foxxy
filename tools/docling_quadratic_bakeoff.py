"""Quarantined no-enrichment Docling parse of the original quadratic PDF."""

from __future__ import annotations

import json
import time
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption


SOURCE = Path(r"D:\onedrive\Desktop\class 10th_maths_4_quadraticEquation.pdf")
OUTPUT = Path(r"D:\personal\foxxy\artifacts\quadratic-equations-docling")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    options = PdfPipelineOptions()
    options.do_ocr = True
    options.do_formula_enrichment = False
    started = time.monotonic()
    document = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    ).convert(SOURCE).document
    elapsed = time.monotonic() - started
    (OUTPUT / "docling.md").write_text(document.export_to_markdown(), encoding="utf-8")
    (OUTPUT / "docling.json").write_text(
        json.dumps(document.export_to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUTPUT / "metadata.json").write_text(
        json.dumps(
            {
                "source": str(SOURCE),
                "pages": len(document.pages),
                "seconds": round(elapsed, 3),
                "ocr": True,
                "formula_enrichment": False,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Complete in {elapsed:.1f}s: {OUTPUT}")


if __name__ == "__main__":
    main()
