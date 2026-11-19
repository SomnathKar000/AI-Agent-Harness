# @harness/agent

LLM coding agent loop, Anthropic Claude client abstraction, prompt management, and tool dispatch.

Hard rule: The Anthropic API key exists only in the host process and is never passed to containers or logged. Tool calls dispatch through the policy engine to the sandbox.
