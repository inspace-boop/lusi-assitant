import os
import re
import shutil
import csv
import fitz  # PyMuPDF
from openai import OpenAI
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

# Initialize environment
load_dotenv(find_dotenv())

# Config
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INGEST_DIR = os.path.join(BASE_DIR, "ingest")
PROCESSED_DIR = os.path.join(INGEST_DIR, "processed")

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
index = pc.Index(os.environ.get("PINECONE_INDEX"))

def ensure_dirs():
    for d in ["rules", "sar", "drive", "processed"]:
        os.makedirs(os.path.join(INGEST_DIR, d), exist_ok=True)

def chunk_rulebook(pdf_path, year):
    print(f"  [Rules] Processing: {os.path.basename(pdf_path)}")
    doc = fitz.open(pdf_path)
    text = "".join([page.get_text() for page in doc])
    
    # Split by alphanumeric subsections (e.g. 1.a, 2.1)
    sections = re.split(r'\n(?=\d+\.[a-zA-Z0-9])', text)
    if len(sections) < 5: sections = re.split(r'\n(?=\d+\.)', text)
    if len(sections) < 5: sections = [text[i:i+1500] for i in range(0, len(text), 1500)]
    
    chunks = []
    for i, sec in enumerate(sections):
        sec = sec.strip()
        if not sec: continue
        match = re.search(r'^(\d+\.\d+(?:\.\d+)?)\s+(.*)', sec)
        section_id = match.group(1) if match else f"Section_{i}"
        
        chunks.append({
            "text": sec,
            "metadata": {
                "section": section_id,
                "year": year,
                "type": "rule",
                "text": sec
            }
        })
    return chunks, "urc_rules"

def chunk_generic_file(file_path, namespace, metadata_base):
    print(f"  [{namespace.upper()}] Processing: {os.path.basename(file_path)}")
    
    raw_chunks = []
    if file_path.lower().endswith('.pdf'):
        doc = fitz.open(file_path)
        # Use exact page blocks for PDFs to keep sections together
        raw_chunks = [page.get_text().strip() for page in doc]
    elif file_path.lower().endswith('.csv'):
        # For budgets/BOMs, we treat each row as a record
        with open(file_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                # Filter out empty cells to save tokens
                filled_row = {k: v for k, v in row.items() if v and v.strip()}
                if filled_row:
                    row_text = ", ".join([f"[{k}]: {v}" for k, v in filled_row.items()])
                    raw_chunks.append(row_text)
    else:
        with open(file_path, 'r', encoding='utf-8') as f:
            text = f.read()
        # Fallback to character chunks for TXT
        raw_chunks = [text[i:i+2500] for i in range(0, len(text), 2500)]

    chunks = []
    for i, content in enumerate(raw_chunks):
        if not content or len(content) < 40: continue
        
        metadata = metadata_base.copy()
        metadata.update({
            "page": i + 1,
            "text": content
        })
        chunks.append({
            "text": content,
            "metadata": metadata
        })
    return chunks

def process_file(file_path, category):
    filename = os.path.basename(file_path).upper()
    chunks = []
    namespace = ""

    if category == "rules":
        year_match = re.search(r'RULES(\d{4})', filename)
        year = int(year_match.group(1)) if year_match else 2026
        chunks, namespace = chunk_rulebook(file_path, year)
    
    elif category == "sar":
        # Detect Team, Year, and Report Type (SAR vs PDR)
        report_type = "SAR" if "SAR" in filename else "PDR" if "PDR" in filename else "Report"
        parts = filename.replace('.PDF', '').replace('.TXT', '').split('_')
        
        team = parts[0] if len(parts) > 0 else "LUSI"
        year = 2026
        for p in parts:
            if re.match(r'\d{4}', p):
                year = int(p[:4])
                break
        
        metadata = {
            "team": team,
            "year": year,
            "type": f"{report_type.lower()}_report",
            "source": f"{team} {report_type} {year}"
        }
        chunks = chunk_generic_file(file_path, "sar_reports", metadata)
        namespace = "sar_reports"

    elif category == "drive":
        # Format: NAME_YEAR_CATEGORY.pdf or TXT
        parts = filename.replace('.pdf', '').replace('.txt', '').split('_')
        name = parts[0]
        year = 2026
        cat = "Archive"
        for p in parts:
            if re.match(r'\d{4}', p): year = int(p[:4])
            if p.lower() in ["bom", "budget", "design", "notes", "reports"]: cat = p.capitalize()

        metadata = {
            "filename": name,
            "year": year,
            "category": cat,
            "type": "google_drive",
            "source": f"Drive: {name}"
        }
        chunks = chunk_generic_file(file_path, "google_drive", metadata)
        namespace = "google_drive"

    if not chunks:
        return False

    # Upload to Pinecone
    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        texts = [c["text"][:8000] for c in batch]
        res = client.embeddings.create(input=texts, model="text-embedding-3-small")
        
        vectors = []
        for j, record in enumerate(res.data):
            p_meta = batch[j]["metadata"]
            # Unique ID generation
            prefix = namespace[:3]
            suffix = p_meta.get("section") or p_meta.get("page") or j
            vec_id = f"{prefix}_{filename}_{suffix}_{j}".replace(" ", "_")
            
            vectors.append({
                "id": vec_id,
                "values": record.embedding,
                "metadata": p_meta
            })
        
        index.upsert(vectors=vectors, namespace=namespace)
        print(f"    Uploaded batch {i//batch_size + 1}")
    
    return True

def main():
    ensure_dirs()
    print("--- LUSI Unified Ingester ---")
    
    found_any = False
    for cat in ["rules", "sar", "drive"]:
        folder = os.path.join(INGEST_DIR, cat)
        files = [f for f in os.listdir(folder) if f.lower().endswith(('.pdf', '.txt'))]
        
        for f in files:
            found_any = True
            file_path = os.path.join(folder, f)
            success = process_file(file_path, cat)
            
            if success:
                dest = os.path.join(PROCESSED_DIR, f)
                # Handle filename collisions in processed folder
                if os.path.exists(dest):
                    dest = os.path.join(PROCESSED_DIR, f"{int(os.path.getmtime(file_path))}_{f}")
                shutil.move(file_path, dest)
                print(f"  [DONE] Moved {f} to processed/")
            else:
                print(f"  [ERROR] Failed to process {f}")

    if not found_any:
        print("No new files found in ingest subfolders.")
    print("-----------------------------")

if __name__ == "__main__":
    main()
