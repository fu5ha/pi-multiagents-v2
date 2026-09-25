# Follow-up: paused sub-agents across reloads

A future version should detect sub-agents whose turns were interrupted by `/reload`, append a user- and agent-visible notice listing those paused sessions, and provide a slash command to resume all paused agents or one selected agent. `followup_task` targeting a paused agent should also resume it automatically. Persist enough run-state metadata to distinguish an interrupted turn from an agent that had already completed normally.
