import os
import argparse
import fitz  # PyMuPDF
from openai import OpenAI
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv
import re

# explicitly look for .env file in parent directories
load_dotenv(find_dotenv())

def chunk_rulebook(pdf_path, year):
    print(f"Loading PDF from {pdf_path}...")
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()

    # Primary method: look for alphanumeric subsections like "1.a", "1.1", "2.b", etc.
    # We look for a newline followed by: digit(s) + dot + (digit or letter)
    sections = re.split(r'\n(?=\d+\.[a-zA-Z0-9])', text)
    
    if len(sections) < 5:
        # Fallback to simple digit-dot lines
        sections = re.split(r'\n(?=\d+\.)', text)
    
    if len(sections) < 5:
        # Fallback to paragraph splitting if regex didn't find much
        sections = re.split(r'\n\s*\n', text)
        
    if len(sections) < 5:
        # Ultimate fallback: split by roughly 1000 characters
        chunk_size = 1500
        sections = [text[i:i+chunk_size] for i in range(0, len(text), chunk_size)]
    
    chunks = []
    for sec in sections:
        sec = sec.strip()
        if not sec: continue
        
        match = re.search(r'^(\d+\.\d+(?:\.\d+)?)\s+(.*)', sec)
        section_id = match.group(1) if match else "Unknown"
        
        task_tag = "general"
        lower_sec = sec.lower()
        if "autonomy" in lower_sec or "autonomous" in lower_sec:
            task_tag = "autonomy"
        elif "equipment servicing" in lower_sec or "manipulator" in lower_sec:
            task_tag = "equipment_servicing"
        elif "science" in lower_sec or "cache" in lower_sec:
            task_tag = "science_cache"
        elif "extreme retrieval" in lower_sec:
            task_tag = "extreme_retrieval"
            
        chunks.append({
            "text": sec,
            "metadata": {
                "section": section_id,
                "task": task_tag,
                "year": year, # Stored as integer for metadata filtering
                "type": "rule",
                "text": sec
            }
        })
    print(f"Divided rulebook into {len(chunks)} chunks.")
    return chunks

def main():
    parser = argparse.ArgumentParser(description="Ingest URC rules into Pinecone")
    parser.add_argument("--pdf", required=True, help="Path to URC rulebook PDF (must be named rulesYYYY.pdf)")
    args = parser.parse_args()

    # Extract year from filename (e.g., rules2026.pdf -> 2026)
    filename = os.path.basename(args.pdf)
    year_match = re.search(r'rules(\d{4})\.pdf', filename, re.IGNORECASE)
    if not year_match:
        print("Error: PDF filename must be in the format rulesYYYY.pdf (e.g. rules2026.pdf)")
        return
        
    current_year = int(year_match.group(1))
    print(f"Detected target year: {current_year}")

    chunks = chunk_rulebook(args.pdf, current_year)

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index_name = os.environ.get("PINECONE_INDEX")
    index = pc.Index(index_name)
    
    # Delete rules older than previous year
    oldest_allowed_year = current_year - 1
    print(f"Cleaning up vector database: Deleting records older than {oldest_allowed_year}...")
    try:
        index.delete(
            filter={"year": {"$lt": oldest_allowed_year}, "type": "rule"},
            namespace='urc_rules'
        )
        print("Cleanup successful.")
    except Exception as e:
        print(f"Warning: Failed to cleanup old rules (skip this if namespace is empty). Error: {e}")

    print("Generating embeddings and uploading to namespace 'urc_rules'...")
    
    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i+batch_size]
        texts = [item["text"][:8000] for item in batch]
        
        res = client.embeddings.create(input=texts, model="text-embedding-3-small")
        
        vectors = []
        for j, record in enumerate(res.data):
            vec = {
                "id": f"urc_{current_year}_{batch[j]['metadata']['section']}_{j}",
                "values": record.embedding,
                "metadata": batch[j]["metadata"]
            }
            vectors.append(vec)
            
        index.upsert(vectors=vectors, namespace='urc_rules')
        print(f"Uploaded batch {i//batch_size + 1}")

    print("Ingestion complete.")

if __name__ == "__main__":
    main()
