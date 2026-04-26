import os
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def inspect_metadata():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    
    print("\n--- INSPECTING SAR_REPORTS NAMESPACE ---")
    
    # Query without a year filter to see what's actually there
    res = index.query(
        vector=[0.0] * 1536, # Dummy vector
        top_k=20, 
        namespace='sar_reports', 
        include_metadata=True
    )
    
    if not res.matches:
        print("No matches found in sar_reports namespace.")
        return

    for m in res.matches:
        meta = m.metadata
        print(f"ID: {m.id}")
        print(f"  Year: {meta.get('year')} (Type: {type(meta.get('year'))})")
        print(f"  Source: {meta.get('source')}")
        print(f"  Type: {meta.get('page_type', 'N/A')}")
        print(f"  Team: {meta.get('team')}")
        print("-" * 20)

if __name__ == "__main__":
    inspect_metadata()
