"""Create a deterministic 30-formula visual comparison set for the parser bake-off."""

from __future__ import annotations

import html
import json
import math
import re
from pathlib import Path

import pypdfium2
from PIL import Image, ImageDraw


PDF = Path(r"D:\onedrive\Desktop\class 10th_maths_4_quadraticEquation.pdf")
DOCLING = Path(r"D:\personal\foxxy\artifacts\quadratic-equations-docling\docling.json")
CHANDRA = Path(r"D:\Downloads\quadratic-chandra\quadratic.json")
OUT = Path(r"D:\personal\foxxy\artifacts\quadratic-formula-validation")
SAMPLE_SIZE = 43


def display_math_by_page(chandra: dict) -> dict[int, list[str]]:
    result: dict[int, list[str]] = {}
    for page_no, page in enumerate(chandra["children"], start=1):
        result[page_no] = [
            html.unescape(" ".join(match.split()))
            for match in re.findall(r'<math display="block">(.*?)</math>', page["html"], re.DOTALL)
        ]
    return result


def sample_indices(total: int) -> set[int]:
    return {round(i * (total - 1) / (SAMPLE_SIZE - 1)) for i in range(SAMPLE_SIZE)}


def crop(page, bbox: dict, output: Path) -> Image.Image:
    bitmap = page.render(scale=2)
    image = bitmap.to_pil()
    height = image.height
    scale = image.width / page.get_size()[0]
    left = max(0, math.floor(bbox["l"] * scale) - 16)
    right = min(image.width, math.ceil(bbox["r"] * scale) + 16)
    top = max(0, math.floor(height - bbox["t"] * scale) - 16)
    bottom = min(image.height, math.ceil(height - bbox["b"] * scale) + 16)
    result = image.crop((left, top, right, bottom)).convert("RGB")
    result.save(output, "PNG")
    return result


def contact_sheet(items: list[tuple[dict, Image.Image]], output: Path) -> None:
    cells: list[Image.Image] = []
    for item, image in items:
        canvas = Image.new("RGB", (720, max(110, image.height + 34)), "white")
        canvas.paste(image.resize((min(700, image.width), min(image.height, 500))), (10, 28))
        ImageDraw.Draw(canvas).text((10, 8), f"#{item['sample_id']} · page {item['page']} · source formula {item['formula_index']}", fill="black")
        cells.append(canvas)
    height = sum(cell.height for cell in cells)
    sheet = Image.new("RGB", (720, height), "white")
    y = 0
    for cell in cells:
        sheet.paste(cell, (0, y))
        y += cell.height
    sheet.save(output, "PNG")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    crops = OUT / "crops"
    crops.mkdir(exist_ok=True)
    docling = json.loads(DOCLING.read_text(encoding="utf-8"))
    chandra = json.loads(CHANDRA.read_text(encoding="utf-8"))
    formulas = [item for item in docling["texts"] if item.get("label") == "formula"]
    assert len(formulas) == 43, f"expected 43 Docling formula regions, found {len(formulas)}"
    chandra_by_page = display_math_by_page(chandra)
    selected = sample_indices(len(formulas))
    pdf = pypdfium2.PdfDocument(PDF)
    manifest: list[dict] = []
    sheets: list[list[tuple[dict, Image.Image]]] = [[]]

    for index, formula in enumerate(formulas):
        provenance = formula["prov"][0]
        page_no = provenance["page_no"]
        if index not in selected:
            continue
        sample_id = len(manifest) + 1
        item = {
            "sample_id": sample_id,
            "formula_index": index + 1,
            "page": page_no,
            "bbox": provenance["bbox"],
            "docling_raw_text": formula.get("orig", ""),
            # Docling sometimes groups several visual lines into one formula
            # region while Chandra emits them individually. Page/order is not
            # a valid one-to-one join, so retain the page-level evidence only.
            "chandra_display_math_on_page": len(chandra_by_page.get(page_no, [])),
        }
        crop_path = crops / f"formula-{sample_id:02d}-page-{page_no}.png"
        image = crop(pdf[page_no - 1], provenance["bbox"], crop_path)
        item["crop"] = str(crop_path)
        manifest.append(item)
        sheets[-1].append((item, image))
        if len(sheets[-1]) == 10 and len(manifest) < SAMPLE_SIZE:
            sheets.append([])

    for index, sheet in enumerate(sheets, start=1):
        contact_sheet(sheet, OUT / f"contact-sheet-{index}.png")
    (OUT / "formula-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "summary.json").write_text(
        json.dumps(
            {
                "docling_formula_regions": len(formulas),
                "sampled": len(manifest),
                "chandra_display_math_by_page": {str(page): len(values) for page, values in chandra_by_page.items()},
                "join_rule": "manual comparison by source crop; parser formula regions are not one-to-one",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Created {len(manifest)} crops and {len(sheets)} contact sheets in {OUT}")


if __name__ == "__main__":
    main()
