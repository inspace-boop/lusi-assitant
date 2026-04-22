# LUSI Rover AI Agent

This project is a centralized AI assistant built for the Lehigh University Space Initiative (LUSI), assisting the team in querying Confluence docs, Jira tickets, the URC rules, and summarizing memory states.

## Architecture

The project consists of a unified Next.js App Router providing both the frontend chat UI and backend RAG (Retrieval-Augmented Generation) API routes. Documents are embedded and retrieved using Pinecone and OpenAI embeddings, while the core chat generation is driven by Claude \`claude-sonnet-4-6\`.

## Setup & Environment Variables

1. Navigate to the `dashboard` directory: `cd dashboard`
2. Run `npm install`
3. Create a `.env.local` file with the following variables:

```env
# Shared Authentication
LUSI_ACCESS_PASSWORD=my_secure_password # The team password to log in

# Atlassian (Jira / Confluence)
ATLASSIAN_DOMAIN=lusi.atlassian.net
ATLASSIAN_EMAIL=account@email.com
ATLASSIAN_API_TOKEN=your_api_token_here

# AI Services
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx

# Pinecone
PINECONE_API_KEY=pc-xxx
PINECONE_INDEX=lusi-rover-agent
URC_YEAR=2025
```

4. Run the development server with `npm run dev`

## Deploying to Vercel

Push the repository to GitHub, and import the `dashboard` folder into Vercel. Be sure to copy all the Environment Variables into the Vercel project settings. Ensure the `Framework Preset` is set to Next.js.

## Data Ingestion

The AI agent uses a unified ingestion system located in the `agent/` directory.

### 1. File-Based Ingestion (Rules, SAR, Drive)
1. Place PDF files into the correct subfolder in `agent/ingest/`:
   - `rules/`: URC Rulebook PDFs (e.g., `rules2026.pdf`)
   - `sar/`: Team SAR reports (e.g., `LUSI_SAR_2025.pdf`)
   - `drive/`: Archived Drive files (e.g., `BOM_2024.pdf`)
2. Run the ingester:
   `python agent/ingest.py`
3. Processed files will be moved to `agent/ingest/processed/` automatically.

### 2. YouTube Ingestion (Transcripts)
For SAR presentation videos, use the dedicated CLI:
`python agent/ingest_youtube.py --url [URL] --team [TEAM] --year [YEAR]`

---

## Memory Features

When chatting with the AI, if a problem is resolved, click the **Store Memory** button in the top right. Claude will summarize the history, determine the subsystem affected, and record it into your Pinecone `memory` namespace. It will automatically be searched on future queries!
