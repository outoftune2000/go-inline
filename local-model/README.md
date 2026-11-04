# Local model controls

Double-click `Go-Inline-Model.cmd` to load the 1.5B or 7B model, unload it to release model RAM/VRAM, or check status. `Start-Local-Model.cmd` and `Stop-Local-Model.cmd` provide single-action launchers. Closing the menu leaves the current model running.

The launchers read the ignored `.local-model.json` in the repository root. Copy `.local-model.example.json` to that name when setting up another machine:

```json
{
  "runtimeDirectory": "C:\\path\\to\\local-runtime"
}
```

That directory must contain `llamacpp/llama-server.exe` with its runtime DLLs and `models/qwen2.5-coder-1.5b-base-q4_k_m.gguf`. The 7B menu option uses `models/qwen2.5-coder-7b-base-q4_k_m.gguf`. Process identity and startup logs also live in that runtime directory. The endpoint defaults to `http://127.0.0.1:18080`.

This machine's config already points to the downloaded runtime and models in the original Codex chat's `work` directory. They are not copied into OneDrive or committed to Git. If that directory is moved, update `.local-model.json` accordingly. Keep the original runtime directory while using those downloads.

Without a local config, the launcher looks in the repository's ignored `work/` directory. Alternatively pass `-RuntimeDirectory` to `Go-Inline-Model-Control.ps1`. No permanent execution-policy change or administrator access is needed.
