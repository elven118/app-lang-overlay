import os
from huggingface_hub import list_repo_files, hf_hub_download

MODELS = {
    "qwen3.5": {
        "repo_id": "bartowski/Qwen3.5-9B-Instruct-GGUF",
        "filename": "Qwen3.5-9B-Instruct-Q4_K_M.gguf",
        "local_dir": "../models"
    },
    "hunyuan": {
        "repo_id": "tencent/HY-MT1.5-7B-GGUF",
        "filename": "HY-MT1.5-7B-Q4_K_M.gguf", 
        "local_dir": "../models"
    },
    "hy-mt-1.8b": {
        "repo_id": "tencent/HY-MT1.5-1.8B-GGUF",
        "filename": "HY-MT1.5-1.8B-Q4_K_M.gguf", 
        "local_dir": "../models"
    }
}

def download_model(model_key):
    if model_key not in MODELS:
        print(f"❌ Cannot find model configuration: {model_key}")
        return

    config = MODELS[model_key]
    repo_id = config["repo_id"]
    filename = config["filename"]
    
    script_dir = os.path.dirname(os.path.abspath(__file__)) 
    local_dir = os.path.abspath(os.path.join(script_dir, config["local_dir"]))

    os.makedirs(local_dir, exist_ok=True)

    print(f"🔍 Checking remote files for {model_key}...")
    print(f"📂 Targeted local directory: {local_dir}")

    try:
        print(f"🚀 Starting download of {filename}...")
        path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=local_dir,
            local_dir_use_symlinks=False
        )
        print(f"✅ {model_key} download completed! Saved at: {path}")
    except Exception as e:
        print(f"❌ Download failed: {e}")

download_model("hunyuan")