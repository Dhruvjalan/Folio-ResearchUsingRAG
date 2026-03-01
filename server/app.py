import os
import base64
import tempfile
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory
from dotenv import load_dotenv
from typing import TypedDict
from flask_cors import CORS 

from llama_index.core import Settings, VectorStoreIndex, StorageContext, load_index_from_storage, SimpleDirectoryReader
from llama_index.core import Document
from llama_index.llms.groq import Groq
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.readers.s3 import S3Reader
from langgraph.graph import StateGraph, END
load_dotenv()

S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")
S3_PREFIX = os.getenv("S3_PREFIX")

AWS_ACCESS_KEY = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")

BASE_DIR = Path.cwd()
STORAGE_DIR = BASE_DIR / "storage"
STORAGE_DIR.mkdir(exist_ok=True)

PORT = int(os.getenv("FLASK_PORT", 5000))
GROQ_MODEL = 'llama-3.3-70b-versatile'

embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-small-en-v1.5")
llm = Groq(model=GROQ_MODEL)

Settings.llm = llm
Settings.embed_model = embed_model
Settings.chunk_size = 512

def get_s3_index():
    """Load or build the S3-backed index."""
    if any(STORAGE_DIR.iterdir()):
        print("---LOADING INDEX FROM LOCAL STORAGE---")
        storage_context = StorageContext.from_defaults(persist_dir=str(STORAGE_DIR))
        return load_index_from_storage(storage_context)
    else:
        print("---PULLING PAPERS FROM S3 AND CREATING INDEX---")
        reader = S3Reader(
            bucket=S3_BUCKET_NAME,
            prefix=S3_PREFIX,
            aws_access_key_id=AWS_ACCESS_KEY,
            aws_secret_access_key=AWS_SECRET_KEY
        )
        documents = reader.load_data()
        index = VectorStoreIndex.from_documents(documents)
        index.storage_context.persist(persist_dir=str(STORAGE_DIR))
        return index

def build_pdf_index(pdf_files: list[dict]) -> VectorStoreIndex:
    """Build an in-memory index from base64-encoded PDFs."""
    print(f"---BUILDING INDEX FROM {len(pdf_files)} UPLOADED PDF(S)---")
    tmp_dir = tempfile.mkdtemp()
    try:
        for pdf in pdf_files:
            file_path = os.path.join(tmp_dir, pdf['name'])
            with open(file_path, 'wb') as f:
                f.write(base64.b64decode(pdf['data']))
        documents = SimpleDirectoryReader(tmp_dir, required_exts=[".pdf"]).load_data()
        return VectorStoreIndex.from_documents(documents)
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)

# --- 4. LANGGRAPH WORKFLOW ---
class GraphState(TypedDict):
    question: str
    context: str
    response: str
    pdf_files: list          # NEW: list of {name, data} dicts
    use_s3: bool             # NEW: whether to query S3 index

def retrieve(state: GraphState):
    contexts = []

    # Query uploaded PDFs
    if state.get("pdf_files"):
        pdf_index = build_pdf_index(state["pdf_files"])
        qe = pdf_index.as_query_engine(similarity_top_k=3)
        result = qe.query(state["question"])
        contexts.append(f"[Uploaded PDFs]\n{result}")

    # Query S3 index
    if state.get("use_s3", True):
        s3_index = get_s3_index()
        qe = s3_index.as_query_engine(similarity_top_k=3)
        result = qe.query(state["question"])
        contexts.append(f"[S3 Documents]\n{result}")

    return {"context": "\n\n".join(contexts) if contexts else "No context available."}

def generate_answer(state: GraphState):
    print("---GENERATING FINAL ANSWER---")
    prompt = f"""
    You are an expert research assistant. Use the provided context AND your general knowledge.
    Context: {state['context']}
    Question: {state['question']}
    Answer:"""
    response = llm.complete(prompt)
    return {"response": str(response)}

# Compile the Workflow
workflow = StateGraph(GraphState)
workflow.add_node("retrieve", retrieve)
workflow.add_node("generate", generate_answer)
workflow.set_entry_point("retrieve")
workflow.add_edge("retrieve", "generate")
workflow.add_edge("generate", END)
rag_graph = workflow.compile()


# --- 5. FLASK API ROUTES ---
app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

@app.route('/')
def index():
    """Serve the frontend."""
    return send_from_directory('.', 'index.html')

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "online", "source": "S3-Bucket"})

@app.route('/response', methods=['POST'])
def get_response():
    """
    Expects JSON:
    {
      "question": "What is RAG?",
      "pdf_files": [{"name": "paper.pdf", "data": "<base64>"}],  // optional
      "use_s3": true  // optional, defaults to True if no PDFs
    }
    """
    data = request.json
    user_question = data.get("question")

    if not user_question:
        return jsonify({"error": "No question provided"}), 400

    pdf_files = data.get("pdf_files", [])
    use_s3 = data.get("use_s3", not bool(pdf_files))  # default: use S3 if no PDFs

    result = rag_graph.invoke({
        "question": user_question,
        "pdf_files": pdf_files,
        "use_s3": use_s3,
        "context": "",
        "response": ""
    })

    return jsonify({
        "status": "success",
        "response": result["response"]
    })

if __name__ == '__main__':
    print(f"Server starting on http://127.0.0.1:{PORT}")
    print(f"Frontend available at http://127.0.0.1:{PORT}/")
    app.run(host='0.0.0.0', port=PORT, debug=True)