import os
from pinecone import Pinecone
from openai import OpenAI
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def deep_probe():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    print("\n--- DEEP PROBE: 2025 DATA ---")
    
    # Let's try to query specifically for the word "LUSI" with a 2025 filter
    res = client.embeddings.create(input=["LUSI"], model="text-embedding-3-small")
    vec = res.data[0].embedding

    # Test 1: Search with integer filter
    print("Testing integer filter [2025]...")
    res_int = index.query(vector=vec, top_k=5, namespace='sar_reports', filter={"year": {"$eq": 2025}}, include_metadata=True)
    print(f"  Results: {len(res_int.matches)}")

    # Test 2: Search with string filter
    print("Testing string filter ['2025']...")
    res_str = index.query(vector=vec, top_k=5, namespace='sar_reports', filter={"year": {"$eq": "2025"}}, include_metadata=True)
    print(f"  Results: {len(res_str.matches)}")

    # Test 3: Search for LUSI 2025 in google_drive (if it was mis-ingested)
    print("Testing google_drive namespace for 2025...")
    res_drive = index.query(vector=vec, top_k=5, namespace='google_drive', filter={"year": {"$eq": 2025}}, include_metadata=True)
    print(f"  Results: {len(res_drive.matches)}")

if __name__ == "__main__":
    deep_probe()
