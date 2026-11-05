# Local model controls

Double-click `Go-Inline-Model.cmd` to load the 1.5B or 7B model, unload it to release model RAM/VRAM, or check status. `Start-Local-Model.cmd` and `Stop-Local-Model.cmd` provide single-action launchers. Closing the menu leaves the current model running.

Choose **5. Download and verify the 1.5B model** to fetch the 986 MB GGUF from GitHub Releases. The downloader checks SHA-256 before making it available to the start launcher. You can also run `powershell -File .\local-model\Go-Inline-Model-Control.ps1 -Action Download` from the repo root. [Model release](https://github.com/outoftune2000/go-inline/releases/tag/local-model-1.5b)

The launchers read the ignored `.local-model.json` in the repository root. Copy `.local-model.example.json` to that name when setting up another machine:

```json
{
  "runtimeDirectory": "C:\\path\\to\\local-runtime"
}
```

That directory must contain `llamacpp/llama-server.exe` with its runtime DLLs and `models/qwen2.5-coder-1.5b-base-q4_k_m.gguf`. The 7B menu option uses `models/qwen2.5-coder-7b-base-q4_k_m.gguf`. Process identity and startup logs also live in that runtime directory. The endpoint defaults to `http://127.0.0.1:18080`.

Get the Windows runtime from [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases). For the optional 7B model, download the [upstream Q4_K_M GGUF](https://huggingface.co/QuantFactory/Qwen2.5-Coder-7B-GGUF/blob/16ba6b11abac189c8f28fa0ddfa5619c4243a0db/Qwen2.5-Coder-7B.Q4_K_M.gguf) and save it under the filename above.

The default model is Alibaba Cloud's Qwen2.5-Coder 1.5B Base, converted to GGUF and quantized to Q4_K_M by QuantFactory. It is provided under Apache 2.0. The release includes the upstream model license. [Original model](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B) · [Pinned quantization](https://huggingface.co/QuantFactory/Qwen2.5-Coder-1.5B-GGUF/blob/73c3c696087d8d57a3005e31f2afe78f43059739/Qwen2.5-Coder-1.5B.Q4_K_M.gguf)

Keep runtime binaries and model weights outside the repository and point `.local-model.json` to them. If that directory is moved, update the local config accordingly. The config is intentionally ignored because it contains a machine-specific path.

Without a local config, the launcher looks in the repository's ignored `work/` directory. Alternatively pass `-RuntimeDirectory` to `Go-Inline-Model-Control.ps1`. No permanent execution-policy change or administrator access is needed.
