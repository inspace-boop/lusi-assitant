# LUSI Unified Ingestion System

Instructions for the LUSI team on how to add data to the AI agent.

## Workflow
1. Place your PDF files in the appropriate subfolder below.
2. Run the ingestion script: `python agent/ingest.py`
3. Files will be processed and automatically moved to the `processed/` folder.

## Folders & Naming Conventions

### 1. rules/
- Place URC Rulebook PDFs here.
- Naming: Must contain the year (e.g., `rules2026.pdf` or `URC_Rules_2025.pdf`).

### 2. sar/
- Place System Acceptance Review (SAR) reports from LUSI or competitors here.
- Naming: `TEAM_SAR_YEAR.pdf` (e.g., `LUSI_SAR_2025.pdf` or `BYU_SAR_2026.pdf`).

### 3. drive/
- Place any other PDF (BOMs, budgets, design notes, archived docs) here.
- Naming options:
    - Best: `FILENAME_YEAR_CATEGORY.pdf` (e.g., `Chassis_BOM_2024_BOM.pdf`)
    - Supported categories: BOM, Budget, Design, Notes, Reports.
    - Simple: `MyDocument.pdf` (Will default to 2026 and "Archive" category).

---

## YouTube Presentations
For YouTube SAR videos, use the dedicated CLI tool:
`python agent/ingest_youtube.py --url [URL] --team [TEAM] --year [YEAR]`
