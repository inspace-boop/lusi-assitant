import os
from pinecone import Pinecone
from openai import OpenAI
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def debug_electronics_retrieval():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    query = "current electronics setup, new PCBs, Jetson Orin"
    print(f"\n--- DEBUGGING RETRIEVAL FOR: '{query}' ---")
    
    # 1. Generate Query Vector
    res = client.embeddings.create(input=[query], model="text-embedding-3-small")
    vec = res.data[0].embedding

    # 2. Search sar_reports for 2026 (Technical only)
    print("\n[Target: 2026 SAR Technical Text]")
    sar_curr = index.query(
        vector=vec, 
        top_k=15, 
        namespace='sar_reports', 
        filter={"year": {"$eq": 2026}, "page_type": {"$ne": "visual_or_gantt"}}, 
        include_metadata=True
    )
    
    for m in sar_curr.matches:
        meta = m.metadata
        print(f"SCORE: {m.score:.3f} | PAGE: {meta.get('page')} | TYPE: {meta.get('page_type')}")
        print(f"  TEXT: {meta.get('text')[:200].replace('\n', ' ')}...")
        print("-" * 20)

    # 3. Search google_drive (Historical)
    print("\n[Target: Google Drive Historical]")
    drive_hist = index.query(
        vector=vec, 
        top_k=5, 
        namespace='google_drive', 
        filter={"year": {"$lt": 2026}}, 
        include_metadata=True
    )
    for m in drive_hist.matches:
        print(f"SCORE: {m.score:.3f} | FILE: {m.metadata.get('filename')}")
        print(f"  TEXT: {m.metadata.get('text')[:200].replace('\n', ' ')}...")
        print("-" * 20)

if __name__ == "__main__":
    debug_electronics_retrieval()
