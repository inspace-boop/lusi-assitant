import os
import re
from pinecone import Pinecone
from openai import OpenAI
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def test_query(query):
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    print(f"\n--- TESTING QUERY: '{query}' ---")
    
    # Get embedding
    res = client.embeddings.create(input=[query], model="text-embedding-3-small")
    vec = res.data[0].embedding

    # Run Dual Search (mimicking route.js logic)
    current_year = 2026
    prev_year = 2025
    
    print("Fetching 2025 Results...")
    res_2025 = index.query(vector=vec, top_k=5, namespace='sar_reports', filter={"year": {"$eq": prev_year}}, include_metadata=True)
    
    print("Fetching 2026 Results...")
    res_2026 = index.query(vector=vec, top_k=5, namespace='sar_reports', filter={"year": {"$eq": current_year}}, include_metadata=True)
    
    print(f"2025 Matches: {len(res_2025.matches)}")
    for m in res_2025.matches:
        print(f"  [2025] Score: {m.score:.3f} | Page: {m.metadata.get('page')} | Type: {m.metadata.get('page_type')}")
        safe_text = m.metadata.get('text', '').encode('ascii', 'ignore').decode('ascii')
        print(f"  Text: {safe_text[:200].replace('\n', ' ')}...")
    
    print(f"\n2026 Matches: {len(res_2026.matches)}")
    for m in res_2026.matches:
        print(f"  [2026] Score: {m.score:.3f} | Page: {m.metadata.get('page')} | Type: {m.metadata.get('page_type')}")
        safe_text = m.metadata.get('text', '').encode('ascii', 'ignore').decode('ascii')
        print(f"  Text: {safe_text[:200].replace('\n', ' ')}...")

if __name__ == "__main__":
    test_query("What were the DCS changes from 2025 to 2026?")
