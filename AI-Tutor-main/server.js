import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import express from "express";
import OpenAI from "openai";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// ===== FILE STORAGE =====
const dataDir = path.join(process.cwd(), "data");
const usersFile = path.join(dataDir, "users.json");
const historyFile = path.join(dataDir, "history.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, "{}");
if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "{}");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf-8") || "{}");
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ===== 🔐 AUTH MIDDLEWARE =====
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header) return res.status(401).json({ error: "No token" });

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ===== ROOT =====
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// ===== 🔑 REGISTER =====
app.post("/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: "Username must be at least 3 characters" });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const users = readJson(usersFile);

    // Check if user already exists
    if (users[username]) {
      return res.status(409).json({ error: "Username already taken" });
    }

    // Create new user
    users[username] = {
      username,
      email: email || null,
      password: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString()
    };

    writeJson(usersFile, users);

    const token = jwt.sign(
      { username },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token, username, message: "Account created successfully" });

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ===== 🔑 LOGIN =====
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const users = readJson(usersFile);

    // Check if user exists
    if (!users[username]) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Verify password
    const valid = await bcrypt.compare(password, users[username].password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Generate token
    const token = jwt.sign(
      { username },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token, username });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ===== 📜 HISTORY =====
app.get("/history", authMiddleware, (req, res) => {
  const history = readJson(historyFile);
  const userHistory = (history[req.user.username] || [])
    .filter(item => item.type !== "meme")
    .slice(-3);
  res.json({ history: userHistory });
});

app.post("/history/record", authMiddleware, (req, res) => {
  const { type, topic, result } = req.body;

  // Ignore meme records in history storage
  if (type === "meme") {
    return res.json({ success: true });
  }

  const user = req.user.username;
  const history = readJson(historyFile);
  history[user] = history[user] || [];

  history[user].push({
    type,
    topic,
    result,
    date: new Date().toISOString()
  });

  // Keep only the 3 most recent entries per user
  history[user] = history[user].slice(-3);

  writeJson(historyFile, history);

  res.json({ success: true });
});

// ===== 🤖 AI CLIENT =====
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// ===== 📘 EXPLAIN =====
app.post("/explain", authMiddleware, async (req, res) => {
  try {
    const { topic, mode } = req.body;

    if (!topic) return res.status(400).json({ error: "Topic required" });

    let prompt;
    
    switch(mode) {
      case "learn":
      case "default":
        prompt = `Provide a detailed educational explanation of "${topic}". Include:
        - Definition and key concepts
        - Main features and characteristics
        - Practical examples
        - Use cases and applications
        Format with clear headings and bullet points.`;
        break;
      case "professor":
        prompt = `Explain "${topic}" as if teaching an advanced university class. Include:
        - Core concepts with technical depth
        - Real-world application details
        - Common misconceptions and pitfalls
        - Further reading suggestions
        Use formal tone but keep the structure clear.`;
        break;
      case "friend":
        prompt = `Explain "${topic}" in a friendly, casual tone, like you're talking to a peer. Include:
        - Simple analogies
        - Everyday examples
        - Short, easy sentences
        - Encouraging tips for learning
        Keep it approachable and conversational.`;
        break;
      case "fun":
      case "meme":
        prompt = `Explain "${topic}" in a fun, humorous, and entertaining way! Include:
        - Funny analogies and comparisons
        - Light-hearted jokes or puns related to the topic
        - Interesting facts presented with humor
        - Creative examples that are amusing
        Keep it educational but make it hilarious!`;
        break;
      case "quiz":
        prompt = `Create 5 quiz questions about "${topic}". Format each question with:
        - Question number
        - The question itself
        - 4 multiple choice options (A, B, C, D)
        - Correct answer
        Make questions progressively harder.`;
        break;
      default:
        prompt = `Explain ${topic} simply with headings, points, and examples.`;
    }

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const text = response.choices[0].message.content;

    const history = readJson(historyFile);
    const user = req.user.username;

    history[user] = history[user] || [];
    history[user].push({ type: "explain", topic, mode, result: text });

    writeJson(historyFile, history);

    res.json({ text });

  } catch {
    res.status(500).json({ error: "Explain failed" });
  }
});

// ===== 😂 MEME =====
// Available meme templates with their formats (using Imgflip template IDs)
const MEME_TEMPLATES = [
  { id: "61544", name: "Success Kid", parts: 1, prompt: "Success Kid meme about {topic}: Generate ONE funny short caption about a win or success." },
  { id: "61585", name: "Bad Luck Brian", parts: 1, prompt: "Bad Luck Brian meme about {topic}: Generate ONE funny unlucky scenario caption." },
  { id: "61581", name: "LOL", parts: 1, prompt: "LOL meme about {topic}: Generate ONE funny caption." },
  { id: "89370399", name: "Woman Yelling at Cat", parts: 2, prompt: "Woman Yelling at Cat meme about {topic}: Generate two captions separated by |. Top caption about complaint, bottom caption cat's response." },
  { id: "93895088", name: "Expanding Brain", parts: 4, prompt: "Expanding Brain meme about {topic}: Generate 4 levels separated by |. Format: bad|better|good|best ideas." }
];

app.post("/meme", authMiddleware, async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic required" });
    }

    const user = req.user.username;

    // Select random template
    const template = MEME_TEMPLATES[Math.floor(Math.random() * MEME_TEMPLATES.length)];

    // Use AI to generate captions for the selected template
    const promptText = template.prompt.replace("{topic}", topic);
    
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: promptText
        }
      ]
    });

    let captionText = response.choices[0].message.content.trim();
    
    // Parse captions based on template parts
    let captions = [];
    if (template.parts === 1) {
      captions = [captionText.substring(0, 60)];
    } else {
      // Split by pipe and trim each caption
      const parts = captionText.split("|").map(p => p.trim().substring(0, 60));
      // For Imgflip, we need specific number of caption boxes
      if (template.parts === 2) {
        captions = [parts[0] || "Top text", parts[1] || "Bottom text"];
      } else if (template.parts === 3) {
        captions = [parts[0] || "Text 1", parts[1] || "Text 2", parts[2] || "Text 3"];
      } else if (template.parts === 4) {
        captions = [parts[0] || "1", parts[1] || "2", parts[2] || "3", parts[3] || "4"];
      }
    }

    // Build Imgflip API request
    const formData = new URLSearchParams();
    formData.append("template_id", template.id);
    formData.append("username", process.env.IMGFLIP_USERNAME);
    formData.append("password", process.env.IMGFLIP_PASSWORD);
    
    // Add captions - Imgflip uses text0, text1, text2, etc.
    captions.forEach((caption, index) => {
      formData.append(`text${index}`, caption);
    });

    const imgflipResponse = await fetch("https://api.imgflip.com/caption_image", {
      method: "POST",
      body: formData
    });

    const imgflipData = await imgflipResponse.json();

    if (!imgflipData.success) {
      throw new Error("Imgflip API error: " + (imgflipData.error_message || "Unknown error"));
    }

    const imageUrl = imgflipData.data.url;

    // Do not save memes in history (user requested no memes in history)
    res.json({ 
      template: template.name,
      captions, 
      image: imageUrl 
    });
  } catch (err) {
    console.error("Meme error:", err);
    res.status(500).json({ error: "Meme generation failed: " + err.message });
  }
});

// ===== 📝 QUIZ =====
app.post("/quiz", authMiddleware, async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic required" });
    }

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { 
          role: "user", 
          content: `Generate 10 quiz questions on "${topic}". Make 5 of the questions conceptually tough and the other 5 medium-level.
          Output ONLY a valid JSON array, no markdown, no explanation before or after.

[
  {"q": "Question 1?", "opts": ["A", "B", "C", "D"], "ans": 0, "exp": "Explanation"},
  {"q": "Question 2?", "opts": ["A", "B", "C", "D"], "ans": 1, "exp": "Explanation"},
  {"q": "Question 3?", "opts": ["A", "B", "C", "D"], "ans": 2, "exp": "Explanation"},
  {"q": "Question 4?", "opts": ["A", "B", "C", "D"], "ans": 3, "exp": "Explanation"},
  {"q": "Question 5?", "opts": ["A", "B", "C", "D"], "ans": 0, "exp": "Explanation"},
  {"q": "Question 6?", "opts": ["A", "B", "C", "D"], "ans": 1, "exp": "Explanation"},
  {"q": "Question 7?", "opts": ["A", "B", "C", "D"], "ans": 2, "exp": "Explanation"},
  {"q": "Question 8?", "opts": ["A", "B", "C", "D"], "ans": 3, "exp": "Explanation"},
  {"q": "Question 9?", "opts": ["A", "B", "C", "D"], "ans": 0, "exp": "Explanation"},
  {"q": "Question 10?", "opts": ["A", "B", "C", "D"], "ans": 1, "exp": "Explanation"}
]

IMPORTANT: Return ONLY the JSON array, nothing else.`
        }
      ]
    });

    let quizText = response.choices[0].message.content.trim();
    
    console.log("Raw response:", quizText);
    
    // Remove markdown code blocks if present
    quizText = quizText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    quizText = quizText.replace(/^```\n?/g, '').replace(/\n?```$/g, '').trim();
    
    // Extract JSON array
    let jsonMatch = quizText.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      quizText = jsonMatch[0];
    }
    
    console.log("Cleaned response:", quizText);
    
    let questions = JSON.parse(quizText);
    
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("Response is not an array");
    }

    // Transform short format to long format
    questions = questions.slice(0, 10).map((q, idx) => {
      if (!q.q || !q.opts || !Array.isArray(q.opts) || q.opts.length < 2 || q.ans === undefined || !q.exp) {
        console.error(`Question ${idx + 1} format:`, q);
        throw new Error(`Question ${idx + 1} missing fields`);
      }
      
      // Ensure correctIndex is valid
      let correctIdx = parseInt(q.ans);
      if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= q.opts.length) {
        correctIdx = 0;
      }

      return {
        question: String(q.q).trim(),
        options: q.opts.map(o => String(o).trim()),
        correctIndex: correctIdx,
        explanation: String(q.exp).trim()
      };
    });

    console.log("Final questions:", JSON.stringify(questions, null, 2));

    res.json({ 
      success: true,
      topic,
      questions
    });

  } catch (err) {
    console.error("Quiz error:", err);
    res.status(500).json({ 
      error: "Quiz generation failed: " + err.message 
    });
  }
});

// ===== 📊 EVALUATE QUIZ =====
app.post("/quiz/evaluate", authMiddleware, async (req, res) => {
  try {
    const { topic, questions, answers } = req.body;

    if (!questions || !answers || questions.length !== answers.length) {
      return res.status(400).json({ error: "Invalid quiz data" });
    }

    let score = 0;
    const results = questions.map((q, idx) => {
      const isCorrect = q.correctIndex === answers[idx];
      if (isCorrect) score++;
      return {
        question: q.question,
        userAnswer: q.options[answers[idx]],
        correctAnswer: q.options[q.correctIndex],
        isCorrect,
        explanation: q.explanation
      };
    });

    const percentage = Math.round((score / questions.length) * 100);

    // Save to history
    const history = readJson(historyFile);
    const user = req.user.username;
    history[user] = history[user] || [];

    history[user].push({
      type: "quiz",
      topic,
      score: `${score}/${questions.length} (${percentage}%)`,
      result: JSON.stringify(results)
    });

    writeJson(historyFile, history);

    res.json({
      success: true,
      score,
      total: questions.length,
      percentage,
      results
    });

  } catch (err) {
    console.error("Evaluation error:", err);
    res.status(500).json({ error: "Quiz evaluation failed" });
  }
});

// ===== START =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🔥 http://localhost:${PORT}`));