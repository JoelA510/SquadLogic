# SquadLogic

An application that converts raw GotSport registration data in CSV format and provides both teaming and scheduling frameworks, intended to support youth sports organizations.

## Project Roadmap Progress

- ✅ [Requirements Analysis & Planning](docs/requirements.md)
- ✅ [Architecture & Technology Selection](docs/architecture.md)
- ✅ [Data Modeling & Storage](docs/data-modeling.md)
- 🚧 [Team Generation](docs/team-generation.md) – allocator, diagnostics, and client-side Team Persistence Panel are implemented; server-side Supabase persistence (Edge Function) is next.
- 🚧 [Practice Scheduling](docs/practice-scheduling.md) – scheduler, metrics, and Supabase helpers exist; persistence snapshot and Practice Persistence Panel are next.
- 🚧 [Game Scheduling](docs/game-scheduling.md) – round-robin generator, allocator, metrics, and Supabase helpers exist; Game Persistence Panel and persistence wiring are next.
- 🚧 [Evaluation & Refinement](docs/evaluation.md) – evaluation pipeline exists; wiring to live runs and persistence into evaluation tables is pending.
- 🚧 [Output Generation & Integration](docs/output-generation.md) – CSV formatters exist; admin export UI and storage integration are pending.
- 🚧 [Front-End Admin Shell](docs/frontend-architecture.md) – admin shell and Team Persistence Panel are implemented; practice/game panels and Auth are pending.

Refer to `roadmap.md` for detailed milestones and task breakdowns.
