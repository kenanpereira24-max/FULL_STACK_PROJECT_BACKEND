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

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"],
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
  let auth;
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: SCOPES,
    });
  } else {
    const KEYFILEPATH = path.join(__dirname, "service-account.json");
    if (fs.existsSync(KEYFILEPATH)) {
      auth = new google.auth.GoogleAuth({
        keyFile: KEYFILEPATH,
        scopes: SCOPES,
      });
    }
  }
  if (auth) driveService = google.drive({ version: "v3", auth });
} catch (e) {}

const PARENT_FOLDER_ID = "17dDMHkoWFjy30ao7HutKbY7qiew1HKyu";

app.post("/api/signup", async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE name = $1 OR e_mail = $2",
      [username, email],
    );
    if (userCheck.rows.length > 0)
      return res
        .status(400)
        .json({ error: "Username or Email already exists" });
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
    let userPlan = "Standard";
    if (user.plan_id) {
      const planRes = await pool.query(
        "SELECT plan_name FROM plan WHERE plan_id = $1",
        [user.plan_id],
      );
      if (planRes.rows.length > 0) userPlan = planRes.rows[0].plan_name;
    }
    res
      .status(200)
      .json({
        user: {
          id: user.user_id,
          username: user.name,
          email: user.e_mail,
          plan: userPlan,
        },
      });
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/profile/:username", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT u.user_id, u.name, u.e_mail, u.password, p.plan_name FROM users u LEFT JOIN plan p ON u.plan_id = p.plan_id WHERE u.name = $1",
      [req.params.username],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Not found" });
    const data = result.rows[0];
    res
      .status(200)
      .json({
        user_id: data.user_id,
        name: data.name,
        email: data.e_mail,
        password: data.password,
        plan: data.plan_name || "Standard",
      });
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/api/folders", async (req, res) => {
  try {
    const { name, userId } = req.body;
    const result = await pool.query(
      "INSERT INTO folder (folder_name, user_id) VALUES ($1, $2) RETURNING folder_id as id, folder_name as name",
      [name, userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Folder error" });
  }
});

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

app.post("/api/files", async (req, res) => {
  try {
    const { name, size, userId, folderId, content } = req.body;
    const result = await pool.query(
      "INSERT INTO file (file_name, file_size, user_id, folder_id, content) VALUES ($1, $2, $3, $4, $5) RETURNING file_id as id",
      [name, size, userId, folderId || null, content],
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: "File error" });
  }
});

app.get("/api/files/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT file_id as id, file_name as name, file_size as size, folder_id as "folderId", content FROM file WHERE user_id = $1',
      [req.params.userId],
    );
    res
      .status(200)
      .json(result.rows.map((f) => ({ ...f, type: f.name.split(".").pop() })));
  } catch (error) {
    res.status(500).json({ error: "Fetch error" });
  }
});

app.put("/api/files/:id", async (req, res) => {
  try {
    await pool.query(
      "UPDATE file SET content = $1, file_size = $2 WHERE file_id = $3",
      [req.body.content, req.body.size, req.params.id],
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Save error" });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!driveService) return res.status(500).json({ error: "Drive error" });
  try {
    const response = await driveService.files.create({
      resource: { name: req.file.originalname, parents: [PARENT_FOLDER_ID] },
      media: {
        mimeType: req.file.mimetype,
        body: fs.createReadStream(req.file.path),
      },
      fields: "id",
    });
    const dbRes = await pool.query(
      "INSERT INTO file (file_name, file_size, user_id, folder_id, content) VALUES ($1, $2, $3, $4, $5) RETURNING file_id",
      [
        req.file.originalname,
        String(req.file.size),
        req.body.userId,
        req.body.folderId !== "null" ? req.body.folderId : null,
        `GDrive ID: ${response.data.id}`,
      ],
    );
    fs.unlinkSync(req.file.path);
    res
      .status(200)
      .json({ fileId: response.data.id, dbFileId: dbRes.rows[0].file_id });
  } catch (error) {
    res.status(500).json({ error: "Upload Failed" });
  }
});

app.post("/api/share", async (req, res) => {
  try {
    const result = await pool.query(
      "INSERT INTO share (permission, user_id) VALUES ('viewer', $1) RETURNING share_id",
      [req.body.userId],
    );
    res
      .status(200)
      .json({
        share_id: result.rows[0].share_id,
        link: `https://cloudsolutions.com/shared/${result.rows[0].share_id}`,
      });
  } catch (error) {
    res.status(500).json({ error: "Share error" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend live on ${PORT}`));
