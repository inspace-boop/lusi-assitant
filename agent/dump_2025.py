import os
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def dump_2025():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    
    print("\n--- DUMPING 2025 SAR DATA ---")
    
    # Query for any vector in the namespace with a 2025 filter
    # We use a zero vector to just get the top 10 matches by filter regardless of similarity
    res = index.query(
        vector=[0.0] * 1536,
        top_k=10,
        namespace='sar_reports',
        filter={"year": {"$eq": 2025}},
        include_metadata=True
    )
    
    if not res.matches:
        print("ALERT: No 2025 data found in sar_reports namespace.")
        return

    for m in res.matches:
        meta = m.metadata
        print(f"ID: {m.id}")
        print(f"  Source: {meta.get('source')}")
        print(f"  Page: {meta.get('page')}")
        text_preview = meta.get('text', '')[:300].replace('\n', ' ')
        print(f"  Text: {text_preview}...")
        print("-" * 30)

if __name__ == "__main__":
    dump_2025()
