import { NextResponse } from 'next/server';
import { Anthropic } from '@anthropic-ai/sdk';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(request) {
  try {
    const { messages } = await request.json();
    if (!messages || messages.length === 0) return NextResponse.json({ success: false });

    // Format transcript
    const transcript = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const prompt = `Analyze this conversation transcript from the LUSI Rover engineering team and extract a single structured memory if a technical problem was discussed and a solution was found or attempted.
If no technical problem was discussed, return EXACTLY the string "NONE".
If a problem was discussed, return a JSON object with EXACTLY these exact keys:
- problem: one-sentence description
- subsystem: MUST be one of: arm, drive, comms, science, power, software, competition_rules, general
- solution: what fixed it (or what was learned/attempted)
- outcome: solved, workaround, unresolved

Transcript:
${transcript}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // specific model requested
      max_tokens: 500,
      system: "You are a data extraction assistant. Return ONLY valid JSON or 'NONE'.",
      messages: [{ role: 'user', content: prompt }]
    });

    const output = response.content[0].text.trim();
    if (output === "NONE") {
      return NextResponse.json({ skipped: true, reason: "No problem detected" });
    }

    let memoryData;
    try {
      memoryData = JSON.parse(output);
    } catch(e) {
      console.warn("Failed to parse LLM memory JSON:", output);
      return NextResponse.json({ error: "Parse error" }, { status: 500 });
    }

    memoryData.date = new Date().toISOString();

    if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX) {
        return NextResponse.json({ success: true, warning: 'Pinecone not configured, memory not saved' });
    }

    // Embed problem + solution text
    const textToEmbed = `Problem: ${memoryData.problem}. Solution: ${memoryData.solution}. Subsystem: ${memoryData.subsystem}`;
    
    const embedRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: textToEmbed,
      encoding_format: "float",
    });
    
    const vector = embedRes.data[0].embedding;
    
    // Upsert
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const index = pinecone.index(process.env.PINECONE_INDEX);
    const memId = `mem_${Date.now()}`;
    
    await index.namespace('memory').upsert([{
      id: memId,
      values: vector,
      metadata: memoryData
    }]);

    return NextResponse.json({ success: true, id: memId, data: memoryData });
  } catch(error) {
    console.error("Memory saving error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
