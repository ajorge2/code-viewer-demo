# CodeArchitect privacy boundaries

The hosted web demo reads its bundled public source. Public API callers cannot upload a folder, select server filesystem paths, switch projects, or remove the shared project. Legacy web questions and selected source context are sent to OpenAI. Requests explicitly disable optional model-response storage; provider retention policies still apply. Parse/basic-summary caches can persist bundled source analysis. Content tracing is off by default; local operators may explicitly enable it.

The local web server binds to loopback and supports trusted single-operator project selection. Source and generated summaries can be cached on that operator's disk. Do not expose this local application as a multi-user service.

The independent MCP entry point is different: it returns bounded source/AST evidence, does not call a model, and does not persist source, requests, results, or trees. Its local root is selected explicitly; the HTTP MCP demonstration exposes synthetic files only. The AI client and its provider may retain returned context. Hosting infrastructure may retain operational metadata.
