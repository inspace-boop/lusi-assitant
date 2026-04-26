import os
import re
from pinecone import Pinecone
from openai import OpenAI
from anthropic import Anthropic
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def simulate_temporal_chat(query):
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    anthropic = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    print(f"\n--- SIMULATING TEMPORAL QUERY: '{query}' ---")
    
    # 1. Generate Embedding
    res = client.embeddings.create(input=[query], model="text-embedding-3-small")
    vec = res.data[0].embedding

    # 2. Tiered Retrieval (Mimicking route.js)
    current_year = 2026
    print(f"Searching Current ({current_year}) vs Historical...")
    
    res_curr = index.query(vector=vec, top_k=5, namespace='sar_reports', filter={"year": {"$eq": current_year}}, include_metadata=True)
    res_hist = index.query(vector=vec, top_k=3, namespace='sar_reports', filter={"year": {"$lt": current_year}}, include_metadata=True)
    
    # 3. Format Context (Mimicking route.js tags)
    curr_text = "\n".join([f"<current_setup year='{m.metadata.get('year')}' source='{m.metadata.get('source')}'>{m.metadata.get('text')}</current_setup>" for m in res_curr.matches])
    hist_text = "\n".join([f"<historical_reference_ONLY_USE_IF_2026_MISSING year='{m.metadata.get('year')}' source='{m.metadata.get('source')}'>{m.metadata.get('text')}</historical_reference_ONLY_USE_IF_2026_MISSING>" for m in res_hist.matches])
    
    context = f"<context>\n<sar_reports>\n{curr_text}\n{hist_text}\n</sar_reports>\n</context>"
    
    # 4. Call Claude with the new System Prompt
    system_prompt = f"""
    You are the LUSI Rover Assistant. 
    CURRENT SEASON: 2026
    
    ### TEMPORAL INTEGRITY (CRITICAL)
    1. Priority: Always prioritize data from the current year (2026).
    2. Stale Data Handling: If you only find info in <historical_reference> tags and NO current season data, you MUST start your response with:
       "Note: 2026 documentation for this subsystem is limited. The following is based on 2025/2024 designs..."
    3. Fixed Fact: The battery is 12V, 100 Ah LiPo.
    """
    
    print("Calling AI to verify logic...")
    response = anthropic.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1024,
        system=system_prompt,
        messages=[{"role": "user", "content": f"{context}\n\nUser Question: {query}"}]
    )
    
    print("\n[AI RESPONSE]\n")
    print(response.content[0].text)

if __name__ == "__main__":
    simulate_temporal_chat("What are the current battery specifications?")
