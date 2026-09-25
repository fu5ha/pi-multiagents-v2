# Follow-up: paused sub-agents across reloads

Implemented: reload detects persisted non-terminal sub-agent turns, posts a user- and agent-visible notice, supports `/multiagents-resume all` or `/multiagents-resume <agent-path>`, and lets `followup_task` resume paused agents.

Remaining edge case: a brand-new child reloaded before Pi flushes its first assistant message may not yet have a child JSONL file to restore.
