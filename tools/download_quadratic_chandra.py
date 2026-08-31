"""Download the quadratic-chapter JSON and extracted images through Datalab."""

from __future__ import annotations

import os
from pathlib import Path

from datalab_sdk import ConvertOptions, DatalabClient


ENV_FILE = Path(r"D:\personal\agts-retrieval\.env")
SOURCE = r"D:\onedrive\Desktop\class 10th_maths_4_quadraticEquation.pdf"
OUTPUT = Path(r"D:\Downloads\quadratic-chandra\quadratic")


def load_key() -> None:
    if os.environ.get("DATALAB_API_KEY"):
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "DATALAB_API_KEY":
            os.environ["DATALAB_API_KEY"] = value.strip().strip('"').strip("'")
            return
    raise RuntimeError("DATALAB_API_KEY is missing from D:\\personal\\agts-retrieval\\.env")


load_key()
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
result = DatalabClient().convert(
    SOURCE,
    options=ConvertOptions(output_format="json", mode="accurate"),
)
result.save_output(str(OUTPUT), save_images=True)
print(f"Saved JSON and images to: {OUTPUT.parent}")
