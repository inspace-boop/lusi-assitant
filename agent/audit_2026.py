import os
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def audit_2026_tags():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    
    print("\n--- AUDITING 2026 PAGE TYPES ---")
    
    # Target 2026 chunks
    res = index.query(
        vector=[0.0] * 1536,
        top_k=50,
        namespace='sar_reports',
        filter={"year": {"$eq": 2026}},
        include_metadata=True
    )
    
    # Sort and filter for Page 4
    for m in sorted(res.matches, key=lambda x: x.id):
        meta = m.metadata
        print(f"ID: {m.id} | Page: {meta.get('page')} | Type: {meta.get('page_type')}")
        if meta.get('page') == 4:
            print(f"  TEXT: {meta.get('text')[:150].replace('\n', ' ')}...")
        print("-" * 30)

if __name__ == "__main__":
    audit_2026_tags()
