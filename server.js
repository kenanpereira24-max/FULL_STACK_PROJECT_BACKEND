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

app.use(cors());
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

  if (auth) {
    driveService = google.drive({ version: "v3", auth });
  }
} catch (e) {}

const PARENT_FOLDER_ID = "17dDMHkoWFjy30ao7HutKbY7qiew1HKyu";

app.post("/api/signup", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE name = $1 OR e_mail = $2",
      [username, email],
    );
    if (userCheck.rows.length > 0) {
      return res
        .status(400)
        .json({ error: "Username or Email already exists" });
    }

    const result = await pool.query(
      "INSERT INTO users (name, e_mail, password) VALUES ($1, $2, $3) RETURNING user_id, name, e_mail",
      [username, email, password],
    );

    res.status(201).json({
      message: "User created successfully",
      user: {
        id: result.rows[0].user_id,
        username: result.rows[0].name,
        email: result.rows[0].e_mail,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Database error during signup" });
  }
});

app.post("/api/login", async (req, res) => {
  const { identifier, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE (name = $1 OR e_mail = $1) AND password = $2",
      [identifier, password],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];

    let userPlan = "Standard";
    if (user.plan_id) {
      const planResult = await pool.query(
        "SELECT plan_name FROM plan WHERE plan_id = $1",
        [user.plan_id],
      );
      if (planResult.rows.length > 0) {
        userPlan = planResult.rows[0].plan_name;
      }
    }

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user.user_id,
        username: user.name,
        email: user.e_mail,
        plan: userPlan,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Database error during login" });
  }
});

app.get("/api/profile/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const result = await pool.query(
      "SELECT u.user_id, u.name, u.e_mail, u.password, u.plan_id, p.plan_name FROM users u LEFT JOIN plan p ON u.plan_id = p.plan_id WHERE u.name = $1",
      [username],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = result.rows[0];
    res.status(200).json({
      user_id: userData.user_id,
      name: userData.name,
      email: userData.e_mail,
      password: userData.password,
      plan: userData.plan_name || "Standard",
    });
  } catch (error) {
    res.status(500).json({ error: "Database error fetching profile" });
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
    res.status(500).json({ error: "Failed to create folder" });
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
    res.status(500).json({ error: "Failed to fetch folders" });
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
    res.status(500).json({ error: "Failed to create file" });
  }
});

app.get("/api/files/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT file_id as id, file_name as name, file_size as size, folder_id as "folderId", content FROM file WHERE user_id = $1',
      [req.params.userId],
    );
    const files = result.rows.map((f) => {
      const extMatch = f.name.match(/\.([^.]+)$/);
      return { ...f, type: extMatch ? extMatch[1] : "file" };
    });
    res.status(200).json(files);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch files" });
  }
});

app.put("/api/files/:id", async (req, res) => {
  try {
    const { content, size } = req.body;
    await pool.query(
      "UPDATE file SET content = $1, file_size = $2 WHERE file_id = $3",
      [content, size, req.params.id],
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to save file" });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!driveService) {
    if (req.file && req.file.path) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Google Drive not configured" });
  }

  try {
    const userId = req.body.userId;
    const folderId = req.body.folderId !== "null" ? req.body.folderId : null;

    const fileMetadata = {
      name: req.file.originalname,
      parents: [PARENT_FOLDER_ID],
    };
    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const response = await driveService.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id",
    });

    const googleDriveId = response.data.id;
    const fileName = req.file.originalname;
    const fileSize = String(req.file.size);
    const contentData = `Google Drive File ID: ${googleDriveId}`;

    const dbRes = await pool.query(
      "INSERT INTO file (file_name, file_size, user_id, folder_id, content) VALUES ($1, $2, $3, $4, $5) RETURNING file_id",
      [fileName, fileSize, userId, folderId, contentData],
    );

    fs.unlinkSync(req.file.path);
    res
      .status(200)
      .json({
        message: "Uploaded successfully!",
        fileId: googleDriveId,
        dbFileId: dbRes.rows[0].file_id,
      });
  } catch (error) {
    if (req.file && req.file.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Upload Failed" });
  }
});

app.post("/api/share", async (req, res) => {
  const { userId, fileId, permission } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO share (permission, file_id, user_id) VALUES ($1, $2, $3) RETURNING share_id",
      [permission || "viewer", fileId || null, userId],
    );
    const shareId = result.rows[0].share_id;

    res.status(200).json({
      share_id: shareId,
      link: `https://cloudsolutions.com/shared/${shareId}`,
    });
  } catch (error) {
    res.status(500).json({ error: "Database error during share" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {});
