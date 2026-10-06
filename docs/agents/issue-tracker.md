# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `docs/plan/`. There is no remote tracker; do not run `gh issue`.

## Conventions

- One feature per directory: `docs/plan/<feature-slug>/`
- The spec is `docs/plan/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `docs/plan/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- A ticket is done once its commits pass a review against `CODING_STANDARDS.md` (the `code-review` skill reads it); run one review per batch of tickets, after the last commit

`docs/plan/rebuild/` is the worked example of this layout.

## When a skill says "publish to the issue tracker"

Create a new file under `docs/plan/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `docs/plan/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `docs/plan/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `docs/plan/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
