const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

// NUCLEAR CORS FIX: Allows Vercel to talk to Railway without being blocked
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const SCOPES = ["https://www.googleapis.com/auth/drive"];
let driveService = null;

try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: SCOPES,
    });
    driveService = google.drive({ version: "v3", auth });
  }
} catch (e) {
  console.error("Google Drive Auth Error:", e);
}

const PARENT_FOLDER_ID = "17dDMHkoWFjy30ao7HutKbY7qiew1HKyu";

// AUTH ENDPOINTS
app.post("/api/signup", async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO users (name, e_mail, password) VALUES ($1, $2, $3) RETURNING user_id, name, e_mail",
      [username, email, password],
    );
    res
      .status(201)
      .json({
        user: {
          id: result.rows[0].user_id,
          username: result.rows[0].name,
          email: result.rows[0].e_mail,
        },
      });
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/api/login", async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE (name = $1 OR e_mail = $1) AND password = $2",
      [identifier, password],
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });
    const user = result.rows[0];
    res
      .status(200)
      .json({
        user: {
          id: user.user_id,
          username: user.name,
          email: user.e_mail,
          plan: "Standard",
        },
      });
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

// FOLDER & FILE ENDPOINTS
app.get("/api/folders/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT folder_id as id, folder_name as name FROM folder WHERE user_id = $1",
      [req.params.userId],
    );
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Fetch error" });
  }
});

app.get("/api/files/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT file_id as id, file_name as name, file_size as size, folder_id as "folderId", content FROM file WHERE user_id = $1',
      [req.params.userId],
    );
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Fetch error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend live on ${PORT}`));
