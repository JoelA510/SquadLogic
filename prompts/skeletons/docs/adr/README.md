# Architecture Decision Records

An ADR records one consequential decision: what was decided, what forces pushed on it, what
was rejected, and what it costs. The reasoning behind a choice evaporates far faster than
the choice itself — a year later the code shows *what* was built, git shows *when*, and
nothing shows *why* the obvious-looking alternative was wrong.

**Write one when** a decision is expensive to reverse or non-obvious to a competent
newcomer: the stack or any component of it, a boundary (what may import what), a data-model
choice with migration cost, anything where a reviewer would reasonably ask "why not X?" and
the answer takes a paragraph. Decisions that were *considered and declined* count — without
a record, the same proposal returns every six months. Don't write one for a choice a reader
can reconstruct from the code in under a minute.

**How:** copy [`0000-template.md`](./0000-template.md) to `NNNN-short-slug.md` (next free
number; numbers are never reused, files never deleted), fill it in with real alternatives —
a "rejected" section made of strawmen launders a preference as an analysis — and open it in
the same PR as the change it justifies. Superseding means a *new* ADR referencing the old
one, and flipping the old one's status to `Superseded by NNNN`; never edit a decided ADR's
substance.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-stack.md) | [Stack: one-line summary] | [Proposed / Accepted] |
