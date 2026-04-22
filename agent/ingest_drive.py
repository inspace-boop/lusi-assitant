import os
import argparse
import fitz
from openai import OpenAI
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def ingest_drive_files(pdf_path, filename, year, category):
    print(f"Loading Drive PDF: {pdf_path}")
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
                "filename": filename,
                "year": year,
                "category": category,
                "page": page_num + 1,
                "type": "google_drive",
                "source": f"Google Drive: {filename} ({year}, {category}) p.{page_num + 1}"
            }
        })
    print(f"Extracted {len(chunks)} chunks from {filename}")
    return chunks

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, help="Path to the PDF file")
    parser.add_argument("--filename", required=True, help="Display name of the file")
    parser.add_argument("--year", required=True, type=int)
    parser.add_argument("--category", required=True, help="Category: BOM, design, budget, archive, etc.")
    args = parser.parse_args()

    chunks = ingest_drive_files(args.pdf, args.filename, args.year, args.category)

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))

    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i+batch_size]
        texts = [item["text"][:8000] for item in batch]
        res = client.embeddings.create(input=texts, model="text-embedding-3-small")
        vectors = [{
            "id": f"drive_{args.filename.replace(' ', '_')}_p{batch[j]['metadata']['page']}",
            "values": record.embedding,
            "metadata": {**batch[j]["metadata"], "text": texts[j]}
        } for j, record in enumerate(res.data)]
        index.namespace('google_drive').upsert(vectors=vectors)
        print(f"Uploaded batch {i//batch_size + 1}")

    print(f"Drive file ingestion complete: {args.filename} ({args.year})")

if __name__ == "__main__":
    main()
