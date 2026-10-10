#!/usr/bin/env python3
"""Transcribe a video through OpenRouter, including files larger than its upload limit."""

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
MAX_UPLOAD_BYTES = 24_000_000  # Leave space below the 25 MB multipart limit.


def duration_of(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def encode_chunk(source, start, length, target):
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", str(start), "-i", str(source), "-t", str(length),
         "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000",
         "-c:a", "libmp3lame", "-b:a", "64k", str(target)],
        check=True,
    )
    if target.stat().st_size >= MAX_UPLOAD_BYTES:
        raise RuntimeError(f"Audio chunk exceeds upload limit: {target}")


def multipart(audio, model, language):
    boundary = uuid.uuid4().hex
    body = bytearray()

    def field(name, value):
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())

    field("model", model)
    field("response_format", "verbose_json")
    field("timestamp_granularities[]", "word")
    if language:
        field("language", language)
    body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"chunk.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode())
    body.extend(audio)
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def transcribe(audio, model, language, key):
    payload, content_type = multipart(audio.read_bytes(), model, language)
    request = urllib.request.Request(
        ENDPOINT, data=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": content_type},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
            if not isinstance(result.get("text"), str):
                raise RuntimeError(f"Unexpected transcription response: {result}")
            return result
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:2000]
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f"OpenRouter HTTP {exc.code}: {detail}") from exc
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 2:
                raise RuntimeError(f"OpenRouter request failed: {exc}") from exc
            time.sleep(2 ** attempt)


def save_json(path, data):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=".writing-", delete=False) as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write("\n")
        temporary = Path(file.name)
    temporary.replace(path)


def format_timestamp(seconds):
    minutes, remainder = divmod(seconds, 60)
    hours, minutes = divmod(int(minutes), 60)
    return f"{hours:02d}:{minutes:02d}:{remainder:06.3f}"


def ascii_diagram(words, duration):
    """A single, readable, deliberately non-linear strip of word durations and pauses."""
    parts = [format_timestamp(0), " |"]
    previous_end = 0
    for word in words:
        start, end = word.get("start"), word.get("end")
        label = str(word.get("word", "")).strip().replace("|", "/")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not label:
            continue
        gap = max(0, start - previous_end)
        if gap >= 0.3:
            parts.append(f"~{gap:.2f}s~|")
        elif gap >= 0.05:
            parts.append("~|")
        duration_marks = min(12, round(max(0, end - start) * 8))
        parts.append(f"{label}{'=' * duration_marks}|")
        previous_end = max(previous_end, end)
    trailing_gap = max(0, duration - previous_end)
    if trailing_gap >= 0.3:
        parts.append(f"~{trailing_gap:.2f}s~")
    elif trailing_gap >= 0.05:
        parts.append("~")
    parts.extend([" ", format_timestamp(duration)])
    return "".join(parts) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path, help="Video or audio file")
    parser.add_argument("--output-dir", type=Path, help="Output directory (default: ./transcripts/VIDEO_NAME-MODEL)")
    parser.add_argument("--chunk-seconds", type=int, default=300, help="Audio seconds per request (default: 300)")
    parser.add_argument("--model", default="elevenlabs/scribe-v2")
    parser.add_argument("--language", help="Optional language code, e.g. en")
    parser.add_argument("--dry-run", action="store_true", help="Show planned chunks without calling OpenRouter")
    args = parser.parse_args()

    source = args.video.expanduser().resolve()
    if not source.is_file():
        parser.error(f"File does not exist: {source}")
    if args.chunk_seconds < 1 or args.chunk_seconds > 1200:
        parser.error("--chunk-seconds must be between 1 and 1200")
    duration = duration_of(source)
    chunks = [(i, i * args.chunk_seconds, min(args.chunk_seconds, duration - i * args.chunk_seconds))
              for i in range(math.ceil(duration / args.chunk_seconds))]
    output = (args.output_dir or Path("transcripts") / f"{source.stem}-{args.model.rsplit('/', 1)[-1]}").expanduser().resolve()
    print(f"{source}: {duration:.2f}s, {len(chunks)} chunk(s), output {output}", file=sys.stderr, flush=True)
    if args.dry_run:
        for i, start, length in chunks:
            print(f"  {i + 1}: {start:.2f}s–{start + length:.2f}s")
        return

    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.json"
    stat = source.stat()
    manifest = {"source": str(source), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                "duration": duration, "chunk_seconds": args.chunk_seconds,
                "model": args.model, "language": args.language}
    if manifest_path.exists():
        if json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
            raise RuntimeError(f"Existing output belongs to a different input or configuration: {output}")
    else:
        save_json(manifest_path, manifest)

    combined = {"source": str(source), "duration": duration, "model": args.model,
                "text": "", "words": [], "segments": [], "chunks": []}
    texts = []
    for i, start, length in chunks:
        part_path = output / f"chunk-{i + 1:04d}.json"
        if part_path.exists():
            result = json.loads(part_path.read_text(encoding="utf-8"))
            print(f"Chunk {i + 1}/{len(chunks)}: cached", file=sys.stderr, flush=True)
        else:
            if not os.environ.get("OPENROUTER_API_KEY"):
                parser.error("Set OPENROUTER_API_KEY before making requests")
            with tempfile.TemporaryDirectory() as temporary:
                audio = Path(temporary) / "chunk.mp3"
                encode_chunk(source, start, length, audio)
                print(f"Chunk {i + 1}/{len(chunks)}: uploading {audio.stat().st_size / 1024 / 1024:.2f} MiB", file=sys.stderr, flush=True)
                result = transcribe(audio, args.model, args.language, os.environ["OPENROUTER_API_KEY"])
            save_json(part_path, result)
        texts.append(result["text"].strip())
        combined["chunks"].append({"start": start, "duration": length,
                                   "response_file": part_path.name, "usage": result.get("usage")})
        for field in ("words", "segments"):
            for item in result.get(field, []):
                shifted = dict(item)
                for timestamp in ("start", "end"):
                    if isinstance(shifted.get(timestamp), (int, float)):
                        shifted[timestamp] = round(shifted[timestamp] + start, 3)
                combined[field].append(shifted)
    combined["text"] = "\n".join(texts)
    save_json(output / "transcript.json", combined)
    (output / "transcript.txt").write_text(combined["text"] + "\n", encoding="utf-8")
    timestamped = "".join(
        f"[{format_timestamp(word['start'])} - {format_timestamp(word['end'])}] {word['word'].strip()}\n"
        for word in combined["words"]
    )
    (output / "transcript_timestamped.txt").write_text(timestamped, encoding="utf-8")
    diagram = ascii_diagram(combined["words"], duration)
    (output / "transcript_diagram.txt").write_text(diagram, encoding="utf-8")
    print(f"Saved transcripts and transcript_diagram.txt in {output}", file=sys.stderr)
    print(diagram, end="")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
