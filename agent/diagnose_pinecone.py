import os
from pinecone import Pinecone
from openai import OpenAI
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def diagnose_namespace(namespace, query):
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    print(f"\n--- Diagnosing Namespace: {namespace} for query: '{query}' ---")
    
    # Get embedding
    res = client.embeddings.create(input=[query], model="text-embedding-3-small")
    vec = res.data[0].embedding

    # Search
    results = index.query(vector=vec, top_k=10, namespace=namespace, include_metadata=True)
    
    for m in results.matches:
        meta = m.metadata
        print(f"ID: {m.id} | Score: {m.score:.4f}")
        print(f"Year: {meta.get('year')} | Team: {meta.get('team')} | Type: {meta.get('type')}")
        print(f"Source: {meta.get('source')} | Filename: {meta.get('filename')}")
        text = meta.get('text', '')[:500].replace('\n', ' ')
        safe_text = text.encode('ascii', 'ignore').decode('ascii')
        print(f"Snippet: {safe_text}...")
        print("-" * 30)

if __name__ == "__main__":
    queries = ["LUSI Vision", "DCS drive chassis suspension"]
    namespaces = ["sar_reports", "google_drive"]
    
    for ns in namespaces:
        for q in queries:
            diagnose_namespace(ns, q)
