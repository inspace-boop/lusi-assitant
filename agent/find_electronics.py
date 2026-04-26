import fitz

def scan_2026_sar():
    doc = fitz.open('agent/ingest/processed/LUSI_SAR_2026.pdf')
    keywords = ["PCB", "PDB", "Power Distribution", "Altium", "Eagle", "Circuit"]
    
    print(f"--- SCANNING 2026 SAR ({len(doc)} pages) ---")
    for i in range(len(doc)):
        text = doc[i].get_text()
        found = [k for k in keywords if k.lower() in text.lower()]
        if found:
            word_count = len(text.split())
            print(f"Page {i+1}: Found {found} | Word Count: {word_count}")
            print(f"  Snippet: {text.encode('ascii', 'ignore').decode()[:300].replace('\n', ' ')}...")
            print("-" * 30)

if __name__ == "__main__":
    scan_2026_sar()
