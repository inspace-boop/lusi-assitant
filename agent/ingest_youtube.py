import os
import re
import argparse
from youtube_transcript_api import YouTubeTranscriptApi
from openai import OpenAI
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

LUSI_SUBSYSTEMS = [
    "drive", "chassis", "suspension", "dcs",
    "arm", "manipulation", "gripper",
    "science", "life detection", "payload",
    "comms", "ubiquiti", "antenna", "communication",
    "autonomy", "gnss", "slam", "navigation", "software",
    "power", "battery", "electrical",
]

def get_video_id(url):
    match = re.search(r'(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})', url)
    return match.group(1) if match else None

def detect_subsystems(text):
    """Return list of subsystem tags present in this chunk."""
    text_lower = text.lower()
    found = [s for s in LUSI_SUBSYSTEMS if s in text_lower]
    return list(set(found)) if found else ["general"]

def format_timestamp(seconds):
    """Convert float seconds → MM:SS string."""
    try:
        m = int(seconds) // 60
        s = int(seconds) % 60
        return f"{m:02d}:{s:02d}"
    except Exception:
        return "00:00"

def chunk_transcript(transcript, chunk_words=350, overlap_words=80):
    """
    Sliding-window chunker with word overlap.
    Each chunk stores: text, start_time of its first segment, end_time of its last.
    Supports both object-style (FetchedTranscriptSnippet) and dict-style segments.
    """
    # Flatten into a list of (word, start_time) pairs
    word_times = []
    for seg in transcript:
        # youtube-transcript-api >= 0.6.3 returns objects; older versions return dicts
        text  = seg.text  if hasattr(seg, 'text')  else seg['text']
        start = seg.start if hasattr(seg, 'start') else seg.get('start', 0)
        for w in text.split():
            word_times.append((w, start))

    chunks = []
    total = len(word_times)
    step = chunk_words - overlap_words
    i = 0

    while i < total:
        window = word_times[i : i + chunk_words]
        text = ' '.join(w for w, _ in window)
        start_time = window[0][1] if window else 0
        end_time   = window[-1][1] if window else 0
        chunks.append({
            "text": text,
            "start_time": start_time,
            "end_time": end_time,
            "start_ts": format_timestamp(start_time),
        })
        i += step

    return chunks

def build_chunk_text(chunk, team, year, video_url, title=""):
    """Prepend a structured header so the LLM sees rich context."""
    header_parts = [
        f"[SOURCE: {team} YouTube Transcript {year}]",
        f"[TYPE: youtube_transcript]",
        f"[TIMESTAMP: {chunk['start_ts']}]",
        f"[VIDEO: {video_url}]",
    ]
    if title:
        header_parts.insert(0, f"[TITLE: {title}]")
    header = "---" + " ".join(header_parts) + "---\n"
    return header + chunk["text"]

def main():
    parser = argparse.ArgumentParser(description="Ingest YouTube transcripts into Pinecone")
    parser.add_argument("--url", required=True, help="YouTube video URL")
    parser.add_argument("--team", required=True, help="Team name (e.g. LUSI, BYU)")
    parser.add_argument("--year", required=True, type=int, help="Year of the video")
    parser.add_argument("--title", default="", help="Optional: video title / description")
    parser.add_argument("--chunk-words", type=int, default=350, help="Words per chunk (default 350)")
    parser.add_argument("--overlap-words", type=int, default=80, help="Overlap between chunks (default 80)")
    args = parser.parse_args()

    video_id = get_video_id(args.url)
    if not video_id:
        print("Error: Invalid YouTube URL")
        return

    # Uppercase the team key for consistent storage (e.g. "wvu" → "WVU")
    # Use --title to carry full names: --title "WVU West Virginia University SAR 2026"
    # The title is embedded into every chunk so semantic search finds it naturally.
    team = args.team.strip().upper()

    print(f"Fetching transcript for: {args.url} ({team} {args.year})")
    try:
        api = YouTubeTranscriptApi()
        transcript_list = api.list(video_id)

        # Preference order: manual EN → auto-generated EN → any available
        transcript_obj = None
        try:
            transcript_obj = transcript_list.find_manually_created_transcript(['en', 'en-US', 'en-GB'])
            print("  Using: manually created English transcript")
        except Exception:
            pass
        if not transcript_obj:
            try:
                transcript_obj = transcript_list.find_generated_transcript(['en', 'en-US'])
                print("  Using: auto-generated English transcript")
            except Exception:
                pass
        if not transcript_obj:
            # Last resort: grab whatever is first
            transcript_obj = next(iter(transcript_list))
            print(f"  Using: fallback transcript (lang={transcript_obj.language_code})")

        transcript = transcript_obj.fetch()
    except Exception as e:
        print(f"Error fetching transcript: {e}")
        return

    # Diagnostics: show raw segment and word counts before chunking
    segments = list(transcript)
    total_words = sum(
        len((seg.text if hasattr(seg, 'text') else seg['text']).split())
        for seg in segments
    )
    print(f"  Raw transcript: {len(segments)} segments, ~{total_words} words, "
          f"~{total_words // 130} min at 130 wpm")

    chunks = chunk_transcript(segments, chunk_words=args.chunk_words, overlap_words=args.overlap_words)
    print(f"Split into {len(chunks)} chunks (words={args.chunk_words}, overlap={args.overlap_words}, "
          f"unique words/chunk≈{args.chunk_words - args.overlap_words}).") 
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))

    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        batch_chunks = chunks[i : i + batch_size]
        texts = [build_chunk_text(c, team, args.year, args.url, args.title) for c in batch_chunks]

        res = client.embeddings.create(input=texts, model="text-embedding-3-small")

        vectors = []
        for j, record in enumerate(res.data):
            c = batch_chunks[j]
            subsystems = detect_subsystems(c["text"])
            vectors.append({
                "id": f"yt_{team}_{args.year}_{i+j}",
                "values": record.embedding,
                "metadata": {
                    "team": team,
                    "year": args.year,
                    "chunk": i + j,
                    "type": "youtube_transcript",
                    "page_type": "youtube_transcript",
                    "source": f"{team} YouTube {args.year}" + (f" — {args.title}" if args.title else ""),
                    "video_url": args.url,
                    "start_time": c["start_time"],
                    "start_ts": c["start_ts"],
                    "subsystems": ", ".join(subsystems),
                    "text": texts[j],
                },
            })

        # Store in dedicated namespace so they can be queried independently
        index.upsert(vectors=vectors, namespace="youtube_transcripts")
        print(f"  Uploaded batch {i // batch_size + 1} → namespace: youtube_transcripts")

    print(f"YouTube ingestion complete: {team} {args.year} ({len(chunks)} chunks)")

if __name__ == "__main__":
    main()
