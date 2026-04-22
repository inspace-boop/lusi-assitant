import os
import argparse
from youtube_transcript_api import YouTubeTranscriptApi
from openai import OpenAI
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def get_video_id(url):
    import re
    match = re.search(r'(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})', url)
    return match.group(1) if match else None

def chunk_transcript(transcript, chunk_size=800):
    chunks = []
    current_chunk = []
    current_length = 0
    for segment in transcript:
        words = segment['text'].split()
        current_chunk.extend(words)
        current_length += len(words)
        if current_length >= chunk_size:
            chunks.append(' '.join(current_chunk))
            current_chunk = []
            current_length = 0
    if current_chunk:
        chunks.append(' '.join(current_chunk))
    return chunks

def main():
    parser = argparse.ArgumentParser(description="Ingest YouTube transcripts into Pinecone")
    parser.add_argument("--url", required=True, help="YouTube video URL")
    parser.add_argument("--team", required=True, help="Team name (e.g. LUSI, BYU)")
    parser.add_argument("--year", required=True, type=int, help="Year of the video")
    args = parser.parse_args()

    video_id = get_video_id(args.url)
    if not video_id:
        print("Error: Invalid YouTube URL")
        return

    print(f"Fetching transcript for: {args.url} ({args.team} {args.year})")
    try:
        transcript = YouTubeTranscriptApi.get_transcript(video_id)
    except Exception as e:
        print(f"Error fetching transcript: {e}")
        return

    chunks = chunk_transcript(transcript)
    print(f"Split into {len(chunks)} chunks.")

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))

    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i+batch_size]
        res = client.embeddings.create(input=batch, model="text-embedding-3-small")
        vectors = [{
            "id": f"yt_{args.team}_{args.year}_chunk{i+j}",
            "values": record.embedding,
            "metadata": {
                "team": args.team,
                "year": args.year,
                "chunk": i + j,
                "type": "youtube_transcript",
                "source": f"{args.team} SAR video {args.year}",
                "video_url": args.url,
                "text": batch[j]
            }
        } for j, record in enumerate(res.data)]
        index.namespace('sar_reports').upsert(vectors=vectors)
        print(f"Uploaded batch {i//batch_size + 1}")

    print(f"YouTube ingestion complete: {args.team} {args.year}")

if __name__ == "__main__":
    main()
