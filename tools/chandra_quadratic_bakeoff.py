"""Quarantined Chandra parse for the Class 10 quadratic-equations PDF."""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


API_URL = "https://www.datalab.to/api/v1/convert"
PROJECT_ENV = Path(r"D:\personal\agts-retrieval\.env")
PDF = Path(r"D:\onedrive\Desktop\class 10th_maths_4_quadraticEquation.pdf")
OUTPUT = Path(r"D:\personal\foxxy\artifacts\quadratic-equations-chandra")


def api_key() -> str:
    if value := os.environ.get("DATALAB_API_KEY"):
        return value
    if PROJECT_ENV.is_file():
        for line in PROJECT_ENV.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "DATALAB_API_KEY":
                return value.strip().strip('"').strip("'")
    raise RuntimeError("DATALAB_API_KEY is missing from the environment or agts-retrieval/.env")


def request_json(url: str, *, method: str = "GET", body: bytes | None = None, content_type: str | None = None) -> dict:
    headers = {"X-API-Key": api_key()}
    if content_type:
        headers["Content-Type"] = content_type
    try:
        with urlopen(Request(url, data=body, headers=headers, method=method), timeout=300) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"Chandra returned HTTP {error.code}: {error.read().decode(errors='replace')}") from error


def multipart(pdf: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    crlf = b"\r\n"
    fields = {"output_format": "json", "mode": "accurate", "add_block_ids": "true"}
    body = bytearray()
    for key, value in fields.items():
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
    mime = mimetypes.guess_type(pdf.name)[0] or "application/pdf"
    body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{pdf.name}\"\r\nContent-Type: {mime}\r\n\r\n".encode())
    body.extend(pdf.read_bytes())
    body.extend(crlf + f"--{boundary}--\r\n".encode())
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def main() -> None:
    if not PDF.is_file():
        raise FileNotFoundError(PDF)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    body, content_type = multipart(PDF)
    submitted = request_json(API_URL, method="POST", body=body, content_type=content_type)
    check_url = submitted["request_check_url"]
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        result = request_json(check_url)
        if result.get("status") == "complete":
            (OUTPUT / "chandra-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            summary = {key: result.get(key) for key in ("page_count", "parse_quality_score", "cost_breakdown", "metadata")}
            (OUTPUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
            print(f"Complete: {OUTPUT}")
            return
        if result.get("status") == "failed":
            raise RuntimeError(f"Chandra failed: {result.get('error', result)}")
        time.sleep(2)
    raise TimeoutError("Chandra did not complete within 30 minutes")


if __name__ == "__main__":
    main()
