# Copilot Instructions

## Project Guidelines
- User is working on a VoIP app with a server and client; current issue: handshakes and audio not working; prefer concise, technical guidance.
- VoIP client should NOT load or follow ports.json; user selects port per connection in the UI.
- Prefers operations to occur in the same UI.
- Do not switch UI to chat view unless chat connection succeeds.
- Prefers chat in a separate window after connecting.

## Documentation
- After adding or modifying any feature, always update `ARCHITECTURE.md` to reflect the change (new protocol messages, commands, classes, IPC channels, config options, file structure, etc.).

## Interaction Guidelines
- When the user explicitly requests no code (e.g., "Du skal ikke lave noget kode"), avoid providing code and only give conceptual guidance or instructions.
- When the user asks a question, answer the question only — do not make code changes or take actions unless explicitly asked.