
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  appName: "City Barangay Boundary Explorer",
});

export const boundaryAssistant = new Agent({
  id: "boundary-assistant",
  name: "Boundary Assistant",
  instructions:
    "You help users explore Philippine city and barangay boundary data in this app. Keep answers practical, concise, and clear about indicative boundary limitations.",
  model: openrouter.chat("openrouter/auto"),
});

export const mastra = new Mastra({
  agents: {
    boundaryAssistant,
  },
});
