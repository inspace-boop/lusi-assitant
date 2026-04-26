import os
from pinecone import Pinecone
from openai import OpenAI
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def find_dcs_2025():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    print("\n--- SEARCHING FOR 2025 DCS TEXT ---")
    
    # Query for the specific engineering terms from Section 1.1
    res = client.embeddings.create(input=["Driveline, Chassis, and Suspension rocker-bogie"], model="text-embedding-3-small")
    vec = res.data[0].embedding

    res_2025 = index.query(
        vector=vec,
        top_k=5,
        namespace='sar_reports',
        filter={"year": {"$eq": 2025}},
        include_metadata=True
    )
    
    for m in res_2025.matches:
        print(f"ID: {m.id} | Score: {m.score:.3f}")
        text_preview = m.metadata.get('text', '')[:300].replace('\n', ' ')
        print(f"  Text: {text_preview}...")
        print("-" * 30)

if __name__ == "__main__":
    find_dcs_2025()
