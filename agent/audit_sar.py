import os
from pinecone import Pinecone
from dotenv import load_dotenv

load_dotenv()

def audit_sar():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    idx = pc.Index(os.environ.get("PINECONE_INDEX"))
    
    print("\n--- AUDITING sar_reports NAMESPACE ---")
    res = idx.query(
        vector=[0.0] * 1536,
        top_k=1000,
        namespace='sar_reports',
        include_metadata=True
    )
    
    counts = {}
    for m in res.matches:
        year = m.metadata.get('year')
        source = m.metadata.get('source')
        key = f"{year} | {source}"
        counts[key] = counts.get(key, 0) + 1
        
    print("\nVector Distribution (Year | Source):")
    for key, count in counts.items():
        print(f"  {key}: {count} vectors")

if __name__ == "__main__":
    audit_sar()
