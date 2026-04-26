import os
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

# Use full path to .env or load local
load_dotenv()

def check_db():
    try:
        api_key = os.environ.get("PINECONE_API_KEY")
        index_name = os.environ.get("PINECONE_INDEX")
        
        if not api_key:
            print("ERROR: PINECONE_API_KEY not found in env.")
            return

        pc = Pinecone(api_key=api_key)
        idx = pc.Index(index_name)
        
        stats = idx.describe_index_stats()
        print("\n--- PINECONE INDEX STATS ---")
        print(stats)
        
        # Check namespaces explicitly
        for ns_name, ns_data in stats.get('namespaces', {}).items():
            print(f"\nNamespace: {ns_name} | Vector Count: {ns_data.get('vector_count')}")
            
            # Sample a 2026 vector from sar_reports
            if ns_name == 'sar_reports':
                res = idx.query(vector=[0.0]*1536, top_k=5, namespace=ns_name, filter={"year": {"$eq": 2026}}, include_metadata=True)
                print(f"  2026 Sample Count (Filter: year=2026): {len(res.matches)}")
                for m in res.matches:
                    print(f"    ID: {m.id} | Year: {m.metadata.get('year')} | Type: {m.metadata.get('page_type')}")
                    
    except Exception as e:
        print(f"ERROR: {str(e)}")

if __name__ == "__main__":
    check_db()
