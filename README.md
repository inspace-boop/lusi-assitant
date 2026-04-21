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

## URC Rulebook Ingestion

Each season, you must re-ingest the URC rules. We provide a simple python script for this. The script expects the file to be named `rulesYYYY.pdf` and will automatically clean up the database to only store the current year and the previous year.

1. Rename the downloaded PDF, for example, `agent/rules2026.pdf`.
2. Ensure you have the `OPENAI_API_KEY` and `PINECONE_API_KEY` environment variables set in `agent/.env`.
3. Install requirements using an Anaconda prompt: `pip install -r requirements.txt`
4. Run the python script:
   `python agent/ingest_rules.py --pdf agent/rules2026.pdf`

This will chunk the text, vectorize it with OpenAI, upload it into the `urc_rules` namespace in Pinecone, and delete any rules older than 2025.

## Memory Features

When chatting with the AI, if a problem is resolved, click the **Store Memory** button in the top right. Claude will summarize the history, determine the subsystem affected, and record it into your Pinecone \`memory\` namespace. It will automatically be searched on future queries!
