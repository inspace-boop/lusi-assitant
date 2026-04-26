import os
import sys
from pinecone import Pinecone
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv())

def wipe_namespace(namespace):
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    print(f"!!! CLEARING ENTIRE NAMESPACE: {namespace} !!!")
    index.delete(delete_all=True, namespace=namespace)
    print("Done.")

def wipe_filename(filename, namespace):
    pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY"))
    index = pc.Index(os.environ.get("PINECONE_INDEX"))
    print(f"Wiping all vectors for '{filename}' in namespace '{namespace}'...")
    try:
        # Try wiping by filename first
        index.delete(filter={"filename": {"$eq": filename}}, namespace=namespace)
        # Also try by source for SAR reports
        index.delete(filter={"source": {"$eq": filename}}, namespace=namespace)
        print("Done.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage:")
        print("  py agent/wipe_file.py --clear NAMESPACE")
        print("  py agent/wipe_file.py FILENAME NAMESPACE")
        sys.exit(1)
    
    if sys.argv[1] == "--clear":
        wipe_namespace(sys.argv[2])
    else:
        wipe_filename(sys.argv[1], sys.argv[2])
