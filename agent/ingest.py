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
    filename = os.path.basename(file_path)
    print(f"  [{namespace.upper()}] Processing: {filename}")
    
    raw_chunks = []
    chunk_metadata = []

    if file_path.lower().endswith('.pdf'):
        doc = fitz.open(file_path)
        # Store pages with their text and index
        pages = []
        for i, page in enumerate(doc):
            text = page.get_text().strip()
            if text:
                pages.append({"num": i + 1, "text": text, "word_count": len(text.split())})
        
        if not pages: return []

        # Dynamic Word Density Detection
        avg_words = sum(p["word_count"] for p in pages) / len(pages)
        full_text = ""
        page_map = [] # Track which character index belongs to which page
        
        for p in pages:
            start_pos = len(full_text)
            full_text += p["text"] + "\n"
            end_pos = len(full_text)
            page_map.append({"start": start_pos, "end": end_pos, "num": p["num"], "words": p["word_count"]})

        # Section Detection for SAR/PDR
        full_text = "\n".join([p["text"] for p in pages])
        # Multi-line numbered header detection: digit + dot + optional subpoints + newline/space + Capital Title
        # We also look for those specific "1.1.", "1.2." patterns we saw in the 2025 report
        sections = re.split(r'\n(?=\s*\d+(?:\.\d+)*\.?\s*[\n\s]+[A-Z])', full_text)
        
        if len(sections) > 1:
            for i, sec in enumerate(sections):
                if not sec.strip(): continue
                pos = full_text.find(sec[:50])
                starting_page = 1
                page_words = 0
                for pm in page_map:
                    if pm["start"] <= pos < pm["end"]:
                        starting_page = pm["num"]
                        page_words = pm["words"]
                        break
                
                s_type = "technical_text"
                sec_lower = sec.lower()
                
                # Gantt Fingerprinting (Catching text-based schedule tables)
                # 1. Header Keywords
                gantt_headers = ["id#", "task", "progress", "days", "margin", "duration", "predecessor"]
                has_headers = sum(1 for h in gantt_headers if h in sec_lower) >= 3
                
                # 2. Date Density (MM/DD/YY or Mon DD, YYYY)
                # We look for /YY, /YYYY, or month names
                date_matches = re.findall(r'\d{1,2}/\d{1,2}/\d{2,4}', sec)
                word_count = len(sec.split())
                date_density = len(date_matches) / word_count if word_count > 0 else 0
                
                # 3. Calendar Pattern (M T W T F S S)
                has_calendar = "m t w t f s s" in sec_lower or "mon tue wed thu fri" in sec_lower
                
                # Final decision: if it looks like a Gantt chart, label it as such even if word count is high
                if has_headers or date_density > 0.05 or has_calendar:
                    s_type = "visual_or_gantt"
                elif (page_words < (avg_words * 0.45) and page_words < 200) or any(k in sec_lower for k in ["budget", "wbs", "timeline"]):
                    s_type = "visual_or_gantt"
                
                # Sub-chunking: If a section is very long, split it so search hits are more precise
                if len(sec) > 2000 and s_type != "visual_or_gantt":
                    sub_parts = [sec[j:j+2000] for j in range(0, len(sec), 2000)]
                    for sp in sub_parts:
                        raw_chunks.append(sp.strip())
                        chunk_metadata.append({"page": starting_page, "type": s_type})
                else:
                    raw_chunks.append(sec.strip())
                    chunk_metadata.append({"page": starting_page, "type": s_type})
        else:
            # Fallback to page-by-page
            for p in pages:
                s_type = "technical_text"
                p_lower = p["text"].lower()
                if (p["word_count"] < (avg_words * 0.45) and p["word_count"] < 200) or any(k in p_lower for k in ["gantt", "schedule", "wbs"]):
                    s_type = "visual_or_gantt"
                raw_chunks.append(p["text"])
                chunk_metadata.append({"page": p["num"], "type": s_type})
                
    elif file_path.lower().endswith('.csv'):
        # CSV handling remains row-by-row
        with open(file_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                filled_row = {k: v for k, v in row.items() if v and v.strip()}
                if filled_row:
                    row_text = ", ".join([f"[{k}]: {v}" for k, v in filled_row.items()])
                    raw_chunks.append(row_text)
                    chunk_metadata.append({"page": 1, "type": "spreadsheet_data"})
    else:
        # Standard text handling
        with open(file_path, 'r', encoding='utf-8') as f:
            text = f.read()
        split_chunks = [text[i:i+2500] for i in range(0, len(text), 2500)]
        for sc in split_chunks:
            raw_chunks.append(sc)
            chunk_metadata.append({"page": 1, "type": "text_data"})

    chunks = []
    for i, content in enumerate(raw_chunks):
        if not content or len(content) < 40: continue
        
        meta_info = chunk_metadata[i] if i < len(chunk_metadata) else {"page": 1, "type": "text_data"}
        p_type = meta_info["type"]
        p_num = meta_info["page"]
        
        year_str = f" [YEAR: {metadata_base.get('year', 'Unknown')}]"
        source_str = f" [SOURCE: {metadata_base.get('source', 'Unknown')}]"
        type_str = f" [TYPE: {p_type}]"
        header = f"---{year_str}{source_str}{type_str}---\n"
        content_with_header = header + content
        
        metadata = metadata_base.copy()
        metadata.update({
            "page": p_num,
            "text": content_with_header,
            "page_type": p_type
        })
        chunks.append({
            "text": content_with_header,
            "metadata": metadata
        })
    return chunks

def process_file(file_path, category):
    filename = os.path.basename(file_path).upper()
    chunks = []
    namespace = ""

    # Universal year detection: search for any 4-digit number starting with 20
    year_found = re.search(r'20\d{2}', filename)
    year = int(year_found.group(0)) if year_found else 2026

    if category == "rules":
        chunks, namespace = chunk_rulebook(file_path, year)
    
    elif category == "sar":
        # Detect Team and Report Type (SAR vs PDR)
        report_type = "SAR" if "SAR" in filename else "PDR" if "PDR" in filename else "Report"
        # Extract team from start of filename
        team_match = re.match(r'^([A-Z0-9]+)', filename)
        team = team_match.group(1) if team_match else "LUSI"
        
        metadata = {
            "team": team,
            "year": int(year),
            "type": f"{report_type.lower()}_report",
            "source": f"{team} {report_type} {year}"
        }
        chunks = chunk_generic_file(file_path, "sar_reports", metadata)
        namespace = "sar_reports"

    elif category == "drive":
        # Handle Drive/BOM filenames
        clean_name = filename.replace('.PDF', '').replace('.TXT', '').replace('.CSV', '')
        
        cat = "Archive"
        if "BOM" in filename: cat = "BOM"
        elif "BUDGET" in filename: cat = "Budget"
        elif "DESIGN" in filename: cat = "Design"

        metadata = {
            "filename": clean_name,
            "year": int(year),
            "category": cat,
            "type": "google_drive",
            "source": f"Drive: {clean_name} ({year})"
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
        files = [f for f in os.listdir(folder) if f.lower().endswith(('.pdf', '.txt', '.csv'))]
        
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
