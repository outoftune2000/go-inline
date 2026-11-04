# Changelog

## 0.3.0

- Limit each suggestion to the enclosing function or one new named function/method; preserve nested callbacks.
- Reuse identical in-flight requests and hot-cache nonempty successful answers for five minutes in bounded memory.
- Keep cached results separate by exact editor context, provider/model, mode, and generation settings.
- Preserve nested parentheses and brackets during suffix deduplication and repair unambiguous delimiter mistakes.
- Correct empty map/slice/array literals using `[` in place of `{`, while preserving generic types and indexing.

## 0.2.0

- Add OpenRouter with separate secure credentials, a tested free-model preset, and zero-price provider routing.
- Pause completions after HTTP 429, honoring Retry-After when available.
- Preserve nested Go braces and string literals when trimming duplicated suffixes.
- Add local replay of saved model outputs for Go validation without consuming API quota.
- Use the Zen-specific endpoint for OpenCode; no Go subscription endpoint is used.

## 0.1.0

- Go ghost-text suggestions with short automatic and longer manual modes.
- Native llama.cpp FIM completion and optional OpenCode Zen Chat Completions.
- Bounded Go context, same-package declaration retrieval, cancellation, and stale-result protection.
- Unit, adapter, lifecycle, extension-host, and 32 reference Go evaluation fixtures.
