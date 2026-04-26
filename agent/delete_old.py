import os
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def main():
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    
    # We know there were exactly 4 chunks for WVU and ROSE because of the bug
    wvu_ids = [f"yt_WVU_2026_{i}" for i in range(10)]
    rose_ids = [f"yt_ROSE_2026_{i}" for i in range(10)]
    
    print("Deleting old WVU chunks...")
    try:
        index.delete(ids=wvu_ids, namespace="youtube_transcripts")
    except Exception as e:
        print("Error deleting WVU:", e)
        
    print("Deleting old ROSE chunks...")
    try:
        index.delete(ids=rose_ids, namespace="youtube_transcripts")
    except Exception as e:
        print("Error deleting ROSE:", e)

    print("Cleanup complete! You can now re-ingest them.")

if __name__ == "__main__":
    main()
