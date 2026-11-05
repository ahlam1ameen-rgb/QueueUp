const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 5000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "queueup.sqlite");
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set before starting QueueUp.");
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('student', 'instructor')),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    student_id TEXT UNIQUE,
    office_location TEXT,
    queue_status TEXT NOT NULL DEFAULT 'closed'
      CHECK (queue_status IN ('open', 'paused', 'closed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instructor_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    other_reason TEXT,
    status TEXT NOT NULL DEFAULT 'waiting'
      CHECK (status IN ('waiting', 'in_office', 'completed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS queue_entries_order
    ON queue_entries(instructor_id, status, id);
  CREATE TABLE IF NOT EXISTS queue_members (
    entry_id INTEGER NOT NULL REFERENCES queue_entries(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ready_notified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(entry_id, student_id)
  );
  CREATE INDEX IF NOT EXISTS queue_members_student ON queue_members(student_id);
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    queue_entry_id INTEGER REFERENCES queue_entries(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS notifications_student_created
    ON notifications(student_id, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS notifications_ready_once
    ON notifications(student_id, queue_entry_id)
    WHERE type = 'ready' AND queue_entry_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS queue_ready_markers (
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    queue_entry_id INTEGER NOT NULL REFERENCES queue_entries(id) ON DELETE CASCADE,
    PRIMARY KEY(student_id, queue_entry_id)
  );
  INSERT OR IGNORE INTO queue_ready_markers (student_id, queue_entry_id)
    SELECT student_id, queue_entry_id FROM notifications
    WHERE type = 'ready' AND queue_entry_id IS NOT NULL;
`);
const queueMemberColumns = db.pragma("table_info(queue_members)");
if (!queueMemberColumns.some((column) => column.name === "ready_notified")) {
  db.exec("ALTER TABLE queue_members ADD COLUMN ready_notified INTEGER NOT NULL DEFAULT 0");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(
  session({
    name: "queueup.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);
app.use(express.static(path.join(__dirname, "public")));

const reasons = new Set(["help", "grades", "assessments", "attendance", "other"]);
const labelFor = {
  help: "Get Help",
  grades: "View or Discuss Grades",
  assessments: "Discuss Assessments",
  attendance: "Discuss Attendance",
  other: "Other",
};

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) return reject(error);
      resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = await hashPassword(password, salt);
  const actualBuffer = Buffer.from(actual.split(":")[1], "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function safeUser(user) {
  return {
    id: user.id,
    role: user.role,
    fullName: user.full_name,
    email: user.email,
    studentId: user.student_id,
    officeLocation: user.office_location,
  };
}

function requireUser(role) {
  return (req, res, next) => {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: "Please log in to continue." });
    if (role && user.role !== role) return res.status(403).json({ error: "This action is not available for your account." });
    next();
  };
}

function getInstructor(id) {
  return db.prepare("SELECT id, full_name, office_location, queue_status FROM users WHERE id = ? AND role = 'instructor'").get(id);
}

function addNotification(studentId, message, type, queueEntryId = null) {
  return db.prepare(`
    INSERT OR IGNORE INTO notifications (student_id, queue_entry_id, message, type)
    VALUES (?, ?, ?, ?)
  `).run(studentId, queueEntryId, message, type).changes > 0;
}

function createReadyNotifications(instructorId) {
  const entries = db.prepare(`
    SELECT id FROM queue_entries
    WHERE instructor_id = ? AND status = 'waiting'
    ORDER BY id
  `).all(instructorId);
  let ahead = 0;
  for (const entry of entries) {
    const members = db.prepare(`
      SELECT m.student_id, m.ready_notified, i.office_location
      FROM queue_members m
      JOIN users i ON i.id = ?
      WHERE m.entry_id = ?
    `).all(instructorId, entry.id);
    if (ahead <= 2) {
      for (const member of members) {
        if (member.ready_notified) continue;
        const marker = db.prepare(`
          INSERT OR IGNORE INTO queue_ready_markers (student_id, queue_entry_id)
          VALUES (?, ?)
        `).run(member.student_id, entry.id);
        if (!marker.changes) {
          db.prepare(`
            UPDATE queue_members SET ready_notified = 1
            WHERE entry_id = ? AND student_id = ?
          `).run(entry.id, member.student_id);
          continue;
        }
        addNotification(
          member.student_id,
          `Get ready! Only 2 or fewer students ahead of you. Head to ${member.office_location}.`,
          "ready",
          entry.id,
        );
        db.prepare(`
          UPDATE queue_members SET ready_notified = 1
          WHERE entry_id = ? AND student_id = ?
        `).run(entry.id, member.student_id);
      }
    }
    ahead += members.length;
  }
}

function notifyQueueMembers(instructorId, type, message) {
  const members = db.prepare(`
    SELECT DISTINCT m.student_id, e.id AS entry_id
    FROM queue_members m
    JOIN queue_entries e ON e.id = m.entry_id
    WHERE e.instructor_id = ? AND e.status IN ('waiting', 'in_office')
  `).all(instructorId);
  for (const member of members) addNotification(member.student_id, message, type, member.entry_id);
}

function getQueueEntries(instructorId) {
  const rows = db.prepare(`
    SELECT e.id, e.instructor_id, e.reason, e.other_reason, e.status, e.created_at,
      m.student_id AS member_id, u.full_name AS member_name, u.student_id AS campus_id
    FROM queue_entries e
    LEFT JOIN queue_members m ON m.entry_id = e.id
    LEFT JOIN users u ON u.id = m.student_id
    WHERE e.instructor_id = ? AND e.status IN ('waiting', 'in_office')
    ORDER BY CASE e.status WHEN 'in_office' THEN 0 ELSE 1 END, e.id, m.created_at, m.student_id
  `).all(instructorId);
  const entries = [];
  for (const row of rows) {
    let entry = entries.find((item) => item.id === row.id);
    if (!entry) {
      entry = {
        id: row.id,
        reason: row.reason,
        reasonLabel: labelFor[row.reason],
        otherReason: row.other_reason,
        status: row.status,
        students: [],
      };
      entries.push(entry);
    }
    if (row.member_id != null) {
      entry.students.push({ id: row.member_id, fullName: row.member_name, studentId: row.campus_id });
    }
  }
  return entries;
}

function studentQueueState(studentId) {
  const active = db.prepare(`
    SELECT e.id AS entry_id, e.instructor_id, e.reason, e.other_reason, e.status AS entry_status,
      e.created_at, i.full_name AS instructor_name, i.office_location, i.queue_status
    FROM queue_members m
    JOIN queue_entries e ON e.id = m.entry_id
    JOIN users i ON i.id = e.instructor_id
    WHERE m.student_id = ? AND e.status IN ('waiting', 'in_office')
    ORDER BY e.id DESC LIMIT 1
  `).get(studentId);
  if (active) {
    const entries = getQueueEntries(active.instructor_id);
    const index = entries.findIndex((entry) => entry.id === active.entry_id);
    const ownEntry = entries[index];
    const ahead = active.entry_status === "in_office"
      ? 0
      : entries.slice(0, index).filter((entry) => entry.status === "waiting")
        .reduce((total, entry) => total + entry.students.length, 0);
    return {
      queue: {
        entryId: active.entry_id,
        instructorId: active.instructor_id,
        instructorName: active.instructor_name,
        officeLocation: active.office_location,
        queueStatus: active.queue_status,
        reason: active.reason,
        reasonLabel: labelFor[active.reason],
        otherReason: active.other_reason,
        entryStatus: active.entry_status,
        groupSize: ownEntry?.students.length || 1,
        ahead,
      },
      notice: null,
    };
  }
  const recent = db.prepare(`
    SELECT e.id, e.status, e.reason, i.full_name AS instructor_name, i.office_location
    FROM queue_members m
    JOIN queue_entries e ON e.id = m.entry_id
    JOIN users i ON i.id = e.instructor_id
    WHERE m.student_id = ? AND e.status IN ('cancelled', 'completed')
    ORDER BY e.id DESC LIMIT 1
  `).get(studentId);
  return {
    queue: null,
    notice: recent?.status === "cancelled"
      ? { type: "cancelled", text: "The queue was closed. Your place has been removed." }
      : null,
  };
}

const registerUser = db.transaction((data) => {
  const result = db.prepare(`
    INSERT INTO users (role, full_name, email, password_hash, student_id, office_location)
    VALUES (@role, @fullName, @email, @passwordHash, @studentId, @officeLocation)
  `).run(data);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
});

const joinQueue = db.transaction((studentId, instructorId, reason, otherReason) => {
  const instructor = getInstructor(instructorId);
  if (!instructor) throw new Error("Instructor not found.");
  if (instructor.queue_status !== "open") throw new Error("This queue is not open right now.");
  const existing = db.prepare(`
    SELECT e.id FROM queue_members m JOIN queue_entries e ON e.id = m.entry_id
    WHERE m.student_id = ? AND e.status IN ('waiting', 'in_office') LIMIT 1
  `).get(studentId);
  if (existing) throw new Error("You are already in a queue. Leave it before joining another.");
  let entry;
  if (reason !== "other") {
    entry = db.prepare(`
      SELECT id FROM queue_entries
      WHERE instructor_id = ? AND reason = ? AND status = 'waiting'
      ORDER BY id LIMIT 1
    `).get(instructorId, reason);
  }
  if (!entry) {
    const inserted = db.prepare(`
      INSERT INTO queue_entries (instructor_id, reason, other_reason)
      VALUES (?, ?, ?)
    `).run(instructorId, reason, reason === "other" ? otherReason : null);
    entry = { id: Number(inserted.lastInsertRowid) };
  }
  db.prepare("INSERT INTO queue_members(entry_id, student_id) VALUES (?, ?)").run(entry.id, studentId);
  const ahead = db.prepare(`
    SELECT COUNT(m.student_id) AS count
    FROM queue_entries e
    LEFT JOIN queue_members m ON m.entry_id = e.id
    WHERE e.instructor_id = ? AND e.status = 'waiting' AND e.id < ?
  `).get(instructorId, entry.id).count;
  addNotification(
    studentId,
    `You joined ${instructor.full_name}'s queue. ${ahead} ${ahead === 1 ? "student" : "students"} ahead of you.`,
    "joined",
    entry.id,
  );
  createReadyNotifications(instructorId);
  return entry.id;
});

const leaveQueue = db.transaction((studentId, entryId) => {
  const membership = db.prepare(`
    SELECT e.id, e.status FROM queue_members m
    JOIN queue_entries e ON e.id = m.entry_id
    WHERE m.entry_id = ? AND m.student_id = ?
  `).get(entryId, studentId);
  if (!membership || !["waiting", "in_office"].includes(membership.status)) {
    throw new Error("Your active queue place could not be found.");
  }
  db.prepare("DELETE FROM queue_members WHERE entry_id = ? AND student_id = ?").run(entryId, studentId);
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM queue_members WHERE entry_id = ?").get(entryId).count;
  if (!remaining) {
    db.prepare("UPDATE queue_entries SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(entryId);
  }
  const instructorId = db.prepare("SELECT instructor_id FROM queue_entries WHERE id = ?").get(entryId).instructor_id;
  createReadyNotifications(instructorId);
});

const advanceQueue = db.transaction((instructorId) => {
  db.prepare(`
    UPDATE queue_entries SET status = 'completed', updated_at = CURRENT_TIMESTAMP
    WHERE instructor_id = ? AND status = 'in_office'
  `).run(instructorId);
  const next = db.prepare(`
    SELECT id FROM queue_entries WHERE instructor_id = ? AND status = 'waiting'
    ORDER BY id LIMIT 1
  `).get(instructorId);
  if (!next) return null;
  db.prepare("UPDATE queue_entries SET status = 'in_office', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(next.id);
  const entry = db.prepare(`
    SELECT e.reason, i.full_name AS instructor_name
    FROM queue_entries e JOIN users i ON i.id = e.instructor_id
    WHERE e.id = ?
  `).get(next.id);
  const memberIds = db.prepare("SELECT student_id FROM queue_members WHERE entry_id = ?").all(next.id);
  const turnMessage = memberIds.length > 1
    ? `You've been called in with your group for ${labelFor[entry.reason]}. Go to ${entry.instructor_name}'s office now.`
    : `It's your turn! Go to ${entry.instructor_name}'s office now.`;
  for (const member of memberIds) addNotification(member.student_id, turnMessage, "turn", next.id);
  createReadyNotifications(instructorId);
  return next.id;
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const role = req.body?.role;
    const fullName = cleanText(req.body?.fullName, 100);
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const studentId = cleanText(req.body?.studentId, 40);
    const officeLocation = cleanText(req.body?.officeLocation, 160);
    if (!["student", "instructor"].includes(role)) return res.status(400).json({ error: "Choose a valid account type." });
    if (fullName.length < 2) return res.status(400).json({ error: "Enter your full name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: "Use a password with at least 10 characters." });
    if (role === "student" && !studentId) return res.status(400).json({ error: "Enter your student ID." });
    if (role === "instructor" && officeLocation.length < 2) return res.status(400).json({ error: "Enter your office location." });
    const passwordHash = await hashPassword(password);
    const user = registerUser({
      role,
      fullName,
      email,
      passwordHash,
      studentId: role === "student" ? studentId : null,
      officeLocation: role === "instructor" ? officeLocation : null,
    });
    req.session.user = safeUser(user);
    res.status(201).json({ user: req.session.user });
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      return res.status(409).json({ error: "That email or student ID is already registered." });
    }
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const role = req.body?.role;
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!["student", "instructor"].includes(role) || !email || !password) {
      return res.status(400).json({ error: "Enter your email and password." });
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND role = ?").get(email, role);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = safeUser(user);
      res.json({ user: req.session.user });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/session", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("queueup.sid");
    res.json({ ok: true });
  });
});

app.get("/api/instructors", requireUser("student"), (_req, res) => {
  const instructors = db.prepare(`
    SELECT u.id, u.full_name, u.office_location, u.queue_status,
      (SELECT COUNT(*) FROM queue_members m
        JOIN queue_entries e ON e.id = m.entry_id
        WHERE e.instructor_id = u.id AND e.status = 'waiting') AS waiting_count
    FROM users u
    WHERE u.role = 'instructor'
    GROUP BY u.id
    ORDER BY u.full_name COLLATE NOCASE
  `).all();
  res.json({ instructors: instructors.map((item) => ({
    id: item.id,
    fullName: item.full_name,
    officeLocation: item.office_location,
    queueStatus: item.queue_status,
    waitingCount: item.waiting_count,
  })) });
});

app.get("/api/student/state", requireUser("student"), (req, res) => {
  const state = studentQueueState(req.session.user.id);
  const instructor = state.queue ? getInstructor(state.queue.instructorId) : null;
  if (instructor) state.queue.queueStatus = instructor.queue_status;
  res.json(state);
});

app.get("/api/notifications/status", requireUser("student"), (req, res) => {
  const studentId = req.session.user.id;
  const parsedAfterId = Number(req.query.afterId);
  const afterId = Number.isSafeInteger(parsedAfterId) && parsedAfterId > 0 ? parsedAfterId : 0;
  const unreadCount = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications
    WHERE student_id = ? AND read_at IS NULL
  `).get(studentId).count;
  const latestId = db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS id FROM notifications WHERE student_id = ?
  `).get(studentId).id;
  const newNotifications = db.prepare(`
    SELECT id, message, type, read_at, created_at
    FROM notifications WHERE student_id = ? AND id > ?
    ORDER BY id ASC LIMIT 100
  `).all(studentId, afterId).map((notification) => ({
    id: notification.id,
    message: notification.message,
    type: notification.type,
    read: Boolean(notification.read_at),
    createdAt: notification.created_at,
  }));
  res.json({ unreadCount, latestId, newNotifications });
});

app.get("/api/notifications", requireUser("student"), (req, res) => {
  const studentId = req.session.user.id;
  const markReadAndList = db.transaction(() => {
    const notifications = db.prepare(`
      SELECT id, message, type, read_at, created_at
      FROM notifications WHERE student_id = ?
      ORDER BY id DESC
    `).all(studentId);
    db.prepare(`
      UPDATE notifications SET read_at = CURRENT_TIMESTAMP
      WHERE student_id = ? AND read_at IS NULL
    `).run(studentId);
    return notifications;
  });
  const notifications = markReadAndList().map((notification) => ({
    id: notification.id,
    message: notification.message,
    type: notification.type,
    wasUnread: !notification.read_at,
    createdAt: notification.created_at,
  }));
  res.json({ notifications, unreadCount: 0 });
});

app.delete("/api/notifications", requireUser("student"), (req, res) => {
  db.prepare("DELETE FROM notifications WHERE student_id = ?").run(req.session.user.id);
  res.json({ ok: true, unreadCount: 0 });
});

app.post("/api/queue/join", requireUser("student"), (req, res, next) => {
  try {
    const instructorId = Number(req.body?.instructorId);
    const reason = cleanText(req.body?.reason, 30);
    const otherReason = cleanText(req.body?.otherReason, 300);
    if (!Number.isSafeInteger(instructorId) || !reasons.has(reason)) {
      return res.status(400).json({ error: "Choose an instructor and a reason for your visit." });
    }
    if (reason === "other" && !otherReason) return res.status(400).json({ error: "Please enter your reason for the visit." });
    const entryId = joinQueue(req.session.user.id, instructorId, reason, otherReason);
    res.status(201).json({ entryId });
  } catch (error) {
    if (/queue|already|Instructor not found/i.test(error.message)) return res.status(409).json({ error: error.message });
    next(error);
  }
});

app.post("/api/queue/leave", requireUser("student"), (req, res, next) => {
  try {
    const entryId = Number(req.body?.entryId);
    if (!Number.isSafeInteger(entryId)) return res.status(400).json({ error: "Queue entry is missing." });
    leaveQueue(req.session.user.id, entryId);
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.get("/api/instructor/queue", requireUser("instructor"), (req, res) => {
  const instructor = getInstructor(req.session.user.id);
  res.json({
    queueStatus: instructor.queue_status,
    entries: getQueueEntries(instructor.id),
  });
});

app.patch("/api/instructor/queue-status", requireUser("instructor"), (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!["open", "paused", "closed"].includes(status)) {
      return res.status(400).json({ error: "Choose a valid queue status." });
    }
    const instructorId = req.session.user.id;
    const update = db.transaction(() => {
      const current = getInstructor(instructorId);
      if (current.queue_status !== status) {
        if (status === "paused") {
          notifyQueueMembers(instructorId, "queue_paused", "The instructor paused the queue. You remain in line.");
        } else if (status === "open" && current.queue_status === "paused") {
          notifyQueueMembers(instructorId, "queue_resumed", "The instructor resumed the queue.");
        } else if (status === "closed") {
          notifyQueueMembers(instructorId, "queue_closed", "The instructor closed the queue. Waiting students have been removed.");
        }
      }
      if (status === "closed") {
        db.prepare(`
          UPDATE queue_entries SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE instructor_id = ? AND status = 'waiting'
        `).run(instructorId);
      }
      db.prepare("UPDATE users SET queue_status = ? WHERE id = ?").run(status, instructorId);
    });
    update();
    res.json({ queueStatus: status, entries: getQueueEntries(instructorId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/instructor/next", requireUser("instructor"), (req, res) => {
  const instructor = getInstructor(req.session.user.id);
  if (instructor.queue_status === "closed") return res.status(409).json({ error: "Open the queue before calling a student." });
  const entryId = advanceQueue(instructor.id);
  if (!entryId) return res.status(409).json({ error: "There are no students waiting." });
  res.json({ entryId, entries: getQueueEntries(instructor.id) });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "That action could not be found." }));
app.use((error, _req, res, _next) => {
  console.error("QueueUp request failed:", error.message);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`QueueUp is listening on port ${PORT}`));
}

module.exports = { app, db };
