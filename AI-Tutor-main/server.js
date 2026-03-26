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
  res.json({ history: history[req.user.username] || [] });
});

app.post("/history/record", authMiddleware, (req, res) => {
  const { type, topic, result } = req.body;
  const user = req.user.username;

  const history = readJson(historyFile);
  history[user] = history[user] || [];

  history[user].push({
    type,
    topic,
    result,
    date: new Date().toISOString()
  });

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

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: `Explain ${topic} simply with headings, points, example.`
        }
      ]
    });

    const text = response.choices[0].message.content;

    const history = readJson(historyFile);
    const user = req.user.username;

    history[user] = history[user] || [];
    history[user].push({ type: "explain", topic, result: text });

    writeJson(historyFile, history);

    res.json({ text });

  } catch {
    res.status(500).json({ error: "Explain failed" });
  }
});

// ===== 😂 MEME =====
app.post("/meme", authMiddleware, async (req, res) => {
  const { topic } = req.body;

  const top = `When studying ${topic}`;
  const bottom = "Brain.exe stopped working";

  const image = `https://api.memegen.link/images/drake/${encodeURIComponent(top)}/${encodeURIComponent(bottom)}.png`;

  res.json({ top, bottom, image });
});

// ===== 📝 QUIZ =====
app.post("/quiz", authMiddleware, async (req, res) => {
  try {
    const { topic } = req.body;

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "user", content: `Make 3 quiz questions on ${topic}` }
      ]
    });

    res.json({ quiz: response.choices[0].message.content });

  } catch {
    res.status(500).json({ error: "Quiz failed" });
  }
});

// ===== START =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🔥 http://localhost:${PORT}`));