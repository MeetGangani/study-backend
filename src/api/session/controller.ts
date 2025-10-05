import { z } from "zod";
import { db } from "../../prismaClient";
import { TokenPayload } from "types";
import { Response, Request } from "express";
import type { Express } from "express";
// Define interface for authenticated request
interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

// Define interface for group creation payload
interface CreateGroupPayload {
  name: string;
  description?: string;
  subject: string;
}

// Validation schemas
const createSessionSchema = z.object({
  name: z.string().min(1, "Session name is required").max(100),
  description: z.string().optional(),
  groupId: z.string().length(24, "Invalid group ID format").regex(/^[0-9a-fA-F]{24}$/, "Invalid group ID format"),
  preRequisites: z.string().optional(),
  time: z.string().transform((str) => new Date(str)),
});

const updateSessionSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
  name: z.string().min(1, "Session name is required").max(100),
  description: z.string().optional(),
});

// Simple extractive summarizer using frequency-weighted sentences
function generateExtractiveSummary(text: string, maxSentences: number = 5): string {
  if (!text) return "";
  const sentences = text
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+/g) || [text];
  const words = text.toLowerCase().match(/[a-zA-Z0-9']+/g) || [];
  const stop = new Set([
    "the","is","in","at","of","a","an","and","or","to","for","on","with","as","by","it","this","that","from","are","be","was","were","will","can","could"
  ]);
  const freq: Record<string, number> = {};
  for (const w of words) {
    if (stop.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  const scores = sentences.map((s) => {
    const sw = s.toLowerCase().match(/[a-zA-Z0-9']+/g) || [];
    let score = 0;
    for (const w of sw) score += freq[w] || 0;
    // normalize by sentence length to avoid bias toward long sentences
    return score / Math.max(5, sw.length);
  });
  const indexed = sentences.map((s, i) => ({ s, i, score: scores[i] }));
  indexed.sort((a, b) => b.score - a.score);
  const top = indexed.slice(0, Math.min(maxSentences, indexed.length)).sort((a, b) => a.i - b.i);
  return top.map((t) => t.s.trim()).join(" ");
}

async function summarizeWithGemini(transcript: string): Promise<string | null> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    // Trim transcript to avoid excessive token usage
    const maxChars = 16000;
    const input = transcript.length > maxChars ? transcript.slice(-maxChars) : transcript;
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "You are an expert note-taker for student study sessions. Summarize the discussion into clear, concise bullet points with headings, action items, and key takeaways. Keep it objective and avoid fabrications. Transcript begins:\n\n" +
                input,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
      },
    };
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
  } catch (e) {
    return null;
  }
}

// get all sessions
export const getAllSessions = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = req.user;
    console.log("Inside getAllSessions");

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const groupId = req.params.groupId;

    if (!groupId) {
      return res.status(400).json({ message: "Group ID is required" });
    }

    // Check if user is a member of the group
    const group = await db.group.findFirst({
      where: {
        id: groupId,
        memberIds: {
          has: user.id,
        },
      },
    });

    if (!group) {
      return res
        .status(403)
        .json({ message: "You are not a member of this group" });
    }

    const sessions = await db.session.findMany({
      where: {
        groupId: groupId,
      }
    });

    res.status(200).json(sessions);
  } catch (error) {
    console.error("Error getting sessions:", error);
    res.status(500).json({ message: "Failed to get sessions" });
  }
};

// create new session
export const createSession = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = req.user;
    console.log("Inside createSession");
    console.log("User: ", user);
    
    console.log(req.body);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Directly use req.body - no JSON.parse needed
    const validationResult = createSessionSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid input data",
        errors: validationResult.error.errors,
      });
    }

    const { name, description, groupId, preRequisites, time } =
      validationResult.data;

    // Check if user is a member of the group
    const group = await db.group.findFirst({
      where: {
        id: groupId,
        memberIds: {
          has: user.id,
        },
      },
    });

    if (!group) {
      return res
        .status(403)
        .json({ message: "You are not a member of this group" });
    }
    
    // const board = await db.board.create({
    //   data: {
    //     title: name,
    //     groupId:groupId,
    //     authorId: user.id,
    //     authorName: user.name,
    //     imageUrl: '/boards/board-' + Math.floor(Math.random() * 18) + 1 + '.svg',
    //   }
    // });

    const session = await db.session.create({
      data: {
        name,
        time,
        description,
        groupId,
        prerequisites: preRequisites,
        creatorID: user.id,
        //boardId: board.id
      },
    });

    res.status(201).json(session);
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({ message: "Failed to create session" });
  }
};

// delete session
export const deleteSession = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const sessionId = req.params.sessionId;

    if (!sessionId) {
      return res.status(400).json({ message: "Session ID is required" });
    }

    // Check if user is a member of the group that owns the session
    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: { group: true },
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    const isMember = await db.group.findFirst({
      where: {
        id: session.groupId,
        memberIds: {
          has: user.id,
        },
      },
    });

    if (!isMember) {
      return res
        .status(403)
        .json({ message: "You are not a member of this group" });
    }

    const deletedSession = await db.session.delete({
      where: {
        id: sessionId,
      },
    });

    res.status(200).json(deletedSession);
  } catch (error) {
    console.error("Error deleting session:", error);
    res.status(500).json({ message: "Failed to delete session" });
  }
};

// update session
export const updateSession = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const sessionId = req.params.sessionId;

    // Update the validation schema to not include sessionId since it's in the URL
    const updateBodySchema = z.object({
      name: z.string().min(1, "Session name is required").max(100),
      description: z.string().optional(),
      time: z.string().transform((str) => new Date(str)),
      prerequisites: z.string().optional().nullable(), 
    });

    const validationResult = updateBodySchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid input data",
        errors: validationResult.error.errors,
      });
    }

    let { name, description , time ,prerequisites } = validationResult.data;

    // Check if user is a member of the group that owns the session
    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: { group: true },
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    const isMember = await db.group.findFirst({
      where: {
        id: session.groupId,
        memberIds: {
          has: user.id,
        },
      },
    });

    if (!isMember) {
      return res
        .status(403)
        .json({ message: "You are not a member of this group" });
    }


    if(prerequisites ==  null || prerequisites === undefined || prerequisites === "null"){
      prerequisites = "";
    }
    const updatedSession = await db.session.update({
      where: {
        id: sessionId,
      },
      data: {
        name,
        description,
        time ,
        prerequisites 
      },
    });

    res.status(200).json(updatedSession);
  } catch (error) {
    console.error("Error updating session:", error);
    res.status(500).json({ message: "Failed to update session" });
  }
};

// Save transcript text from client (Web Speech API) and generate summary
export const uploadTranscript = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    const sessionId = req.params.sessionId;
    const bodySchema = z.object({
      transcript: z.string().min(1),
      lang: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    const session = await db.session.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    // ensure user is in the group
    const isMember = await db.group.findFirst({
      where: { id: session.groupId, memberIds: { has: user.id } },
    });
    if (!isMember) return res.status(403).json({ message: "Forbidden" });

    const transcript = parsed.data.transcript;
    const lang = parsed.data.lang;

    // naive merge: append if existing
    const existingTranscript = (session as any).transcript as string | undefined;
    const mergedTranscript = existingTranscript
      ? existingTranscript + "\n" + transcript
      : transcript;

    // mark status pending before generating summary
    await db.session.update({
      where: { id: sessionId },
      // cast to any until prisma generate is run
      data: { transcript: mergedTranscript, summaryStatus: "pending", transcriptLang: lang } as any,
    });

    // Try Gemini; if unavailable or fails, fallback to extractive summary
    const llmSummary = await summarizeWithGemini(mergedTranscript);
    const summary = llmSummary || generateExtractiveSummary(mergedTranscript, 5);
    await db.session.update({
      where: { id: sessionId },
      data: { summary, summaryStatus: "completed" } as any,
    });

    return res.status(200).json({ message: "Transcript saved", summary });
  } catch (err) {
    console.error("uploadTranscript error", err);
    return res.status(500).json({ message: "Failed to save transcript" });
  }
};

export const getSummary = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    const sessionId = req.params.sessionId;
    const session = await db.session.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    const isMember = await db.group.findFirst({
      where: { id: session.groupId, memberIds: { has: user.id } },
    });
    if (!isMember) return res.status(403).json({ message: "Forbidden" });

    const s: any = session as any;
    return res.status(200).json({
      transcript: s.transcript || null,
      summary: s.summary || null,
      status: s.summaryStatus || (s.summary ? "completed" : "not_available"),
      lang: s.transcriptLang || null,
    });
  } catch (err) {
    console.error("getSummary error", err);
    return res.status(500).json({ message: "Failed to fetch summary" });
  }
};

// Add these new controller functions

export const startSession = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<Response> => {
  try {
    const user = req.user;
    const { sessionId } = req.params;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: { group: true }
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    if (session.creatorID !== user.id) {
      return res.status(403).json({ message: "Only session creator can start the session" });
    }

    if (session.isStarted) {
      return res.status(400).json({ message: "Session already started" });
    }

    const updatedSession = await db.session.update({
      where: { id: sessionId },
      data: {
        isStarted: true,
        startedAt: new Date(),
      }
    });

    return res.status(200).json({ 
      message: "Session started successfully",
      session: updatedSession 
    });

  } catch (error) {
    console.error("Error starting session:", error);
    return res.status(500).json({ message: "Failed to start session" });
  }
};

export const endSession = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<Response> => {
  try {
    const user = req.user;
    const { sessionId } = req.params;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: { group: true }
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    if (session.creatorID !== user.id) {
      return res.status(403).json({ message: "Only session creator can end the session" });
    }

    if (!session.isStarted) {
      return res.status(400).json({ message: "Session hasn't started yet" });
    }

    if (session.endedAt) {
      return res.status(400).json({ message: "Session already ended" });
    }

    const updatedSession = await db.session.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date()
      }
    });

    return res.status(200).json({ 
      message: "Session ended successfully",
      session: updatedSession 
    });

  } catch (error) {
    console.error("Error ending session:", error);
    return res.status(500).json({ message: "Failed to end session" });
  }
};
