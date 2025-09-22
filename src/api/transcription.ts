import express from "express";
import multer from "multer";
import type { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// POST /api/transcribe
router.post("/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ error: "Missing DEEPGRAM_API_KEY" });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    // Send audio buffer to Deepgram
    const dgUrl =
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true";
    const dgResp = await fetch(dgUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": req.file.mimetype || "audio/webm",
      },
      body: new Uint8Array(req.file.buffer),
    });

    if (!dgResp.ok) {
      const errText = await dgResp.text();
      return res.status(502).json({ error: "Deepgram error", details: errText });
    }
    const dgJson: any = await dgResp.json();

    // Safely extract transcript
    const transcript =
      dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    // Summarize with Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `You are a study assistant. Summarize the following study discussion into:
- Key takeaways
- Concepts explained
- Action items/homework
- Questions raised

Keep it concise and structured with bullet points.

Transcript:
${transcript}`;

    const summaryResult = await model.generateContent([{ text: prompt }]);
    const summary = summaryResult.response.text();

    return res.json({ transcript, summary });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: err?.message });
  }
});

export default router;
