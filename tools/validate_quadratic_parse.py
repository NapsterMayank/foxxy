"""Repeatable source-to-Chandra validation for the quadratic parser bake-off."""

from __future__ import annotations

import difflib
import html
import json
import re
from pathlib import Path

from pypdf import PdfReader


PDF = Path(r"D:\onedrive\Desktop\class 10th_maths_4_quadraticEquation.pdf")
CHANDRA = Path(r"D:\Downloads\quadratic-chandra\quadratic.json")
ASSETS = Path(r"D:\Downloads\quadratic-chandra")
OUT = Path(r"D:\personal\foxxy\artifacts\quadratic-parse-validation.json")
MIN_TEXT_SIMILARITY = 0.85


def plain_html(value: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", value)).split())


def normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def main() -> None:
    pdf = PdfReader(PDF)
    chandra = json.loads(CHANDRA.read_text(encoding="utf-8"))
    pages = chandra["children"]
    page_results = []
    for number, (source, parsed) in enumerate(zip(pdf.pages, pages), start=1):
        source_text = source.extract_text() or ""
        parsed_text = plain_html(parsed["html"])
        similarity = difflib.SequenceMatcher(
            None, normalise(source_text), normalise(parsed_text), autojunk=False
        ).ratio()
        page_results.append({
            "page": number,
            "source_characters": len(source_text),
            "parsed_characters": len(parsed_text),
            "normalised_text_similarity": round(similarity, 4),
            "text_gate": "PASS" if similarity >= MIN_TEXT_SIMILARITY else "REVIEW",
        })

    raw = CHANDRA.read_text(encoding="utf-8")
    parsed_html = "\n".join(item["html"] for item in pages)
    image_refs = sorted(set(re.findall(r"src=['\"]([^'\"]+\.(?:png|jpe?g|webp))['\"]", parsed_html, re.I)))
    page_polygons = [item.get("polygon") for item in pages]
    report = {
        "source_pages": len(pdf.pages),
        "parsed_pages": len(pages),
        "page_coverage_gate": "PASS" if len(pdf.pages) == len(pages) else "FAIL",
        "page_text": page_results,
        "chandra_math_tags": len(re.findall(r"<math", raw)),
        "chandra_image_references": image_refs,
        "all_referenced_images_present": all((ASSETS / ref).is_file() for ref in image_refs),
        "chandra_table_tags": len(re.findall(r"<table", raw)),
        "citation_geometry_gate": "FAIL_PAGE_LEVEL_ONLY" if all(polygon == page_polygons[0] for polygon in page_polygons) else "REVIEW",
        "known_limit": "Chandra Forge JSON has one full-page polygon per page, not element-level bounding boxes.",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
