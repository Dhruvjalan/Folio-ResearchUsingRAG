import os
from groq import Groq
from google.colab import userdata, files
from dotenv import load_dotenv

load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
def get_available_groq_models():
    client = Groq(api_key=GROQ_API_KEY)
    models = client.models.list()

    # Extracting model IDs
    return [model.id for model in models.data]

print("Available Groq Models:", get_available_groq_models())