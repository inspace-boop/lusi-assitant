import os
import argparse
import fitz
from openai import OpenAI
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv
import re

load_dotenv(find_dotenv())

def ingest_sar(pdf_path, team_name, year):
    print(f"Loading SAR PDF: {pdf_path}")
    doc = fitz.open(pdf_path)
    
    # Extract per page with page number metadata
    chunks = []
    for page_num, page in enumerate(doc):
        text = page.get_text().strip()
        if not text or len(text) < 50:
            continue
        chunks.append({
            "text": text,
            "metadata": {
                "team": team_name,
                "year": year,
                "page": page_num + 1,
                "type": "sar_report",
                "source": f"{team_name} SAR {year} p.{page_num + 1}"
            }
        })
    print(f"Extracted {len(chunks)} pages from {team_name} {year} SAR")
    return chunks

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--team", required=True, help="Team name e.g. LUSI or BYU or MIT")
    parser.add_argument("--year", required=True, type=int)
    args = parser.parse_args()

    chunks = ingest_sar(args.pdf, args.team, args.year)

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))

    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i+batch_size]
        texts = [item["text"][:8000] for item in batch]
        res = client.embeddings.create(input=texts, model="text-embedding-3-small")
        vectors = [{
            "id": f"sar_{args.team}_{args.year}_p{batch[j]['metadata']['page']}",
            "values": record.embedding,
            "metadata": {**batch[j]["metadata"], "text": texts[j]}
        } for j, record in enumerate(res.data)]
        index.namespace('sar_reports').upsert(vectors=vectors)
        print(f"Uploaded batch {i//batch_size + 1}")

    print(f"SAR ingestion complete: {args.team} {args.year}")

if __name__ == "__main__":
    main()
