const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "queueup-test-"));
process.env.DB_PATH = path.join(tempDir, "queueup.sqlite");
process.env.SESSION_SECRET = "integration-tests-only-secret-value";
const { app, db } = require("../server");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function api(pathname, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    data,
    cookie: setCookie?.split(";")[0] || cookie,
  };
}

async function register(role, suffix, extra = {}) {
  const result = await api("/api/auth/register", {
    method: "POST",
    body: {
      role,
      fullName: `${role} ${suffix}`,
      email: `${role}-${suffix}@example.edu`,
      password: "secure-test-password-123",
      ...(role === "student" ? { studentId: `S-${suffix}` } : { officeLocation: "Building C, Room 214" }),
      ...extra,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { user: result.data.user, cookie: result.cookie };
}

test("accounts, live queue grouping, status controls, and ahead count work", async () => {
  const emptyRoster = await register("student", "roster");
  let instructors = await api("/api/instructors", { cookie: emptyRoster.cookie });
  assert.deepEqual(instructors.data.instructors, []);

  const instructor = await register("instructor", "owner");
  const first = await register("student", "first");
  const second = await register("student", "second");
  const third = await register("student", "third");
  const fourth = await register("student", "fourth");

  const opened = await api("/api/instructor/queue-status", {
    method: "PATCH", cookie: instructor.cookie, body: { status: "open" },
  });
  assert.equal(opened.data.queueStatus, "open");

  const addFirst = await api("/api/queue/join", {
    method: "POST", cookie: first.cookie,
    body: { instructorId: instructor.user.id, reason: "assessments" },
  });
  const addSecond = await api("/api/queue/join", {
    method: "POST", cookie: second.cookie,
    body: { instructorId: instructor.user.id, reason: "assessments" },
  });
  assert.equal(addFirst.data.entryId, addSecond.data.entryId, "matching waiting reasons share one entry");

  const firstNotifications = await api("/api/notifications/status?afterId=0", { cookie: first.cookie });
  assert.equal(firstNotifications.data.unreadCount, 2, "joining with no one ahead creates joined and ready notifications");
  assert.deepEqual(
    firstNotifications.data.newNotifications.map((notification) => notification.type),
    ["joined", "ready"],
  );
  const openedNotifications = await api("/api/notifications", { cookie: first.cookie });
  assert.ok(openedNotifications.data.notifications.every((notification) => notification.wasUnread));
  assert.ok(openedNotifications.data.notifications[0].id > openedNotifications.data.notifications[1].id,
    "notifications are returned newest first");
  assert.equal((await api("/api/notifications/status", { cookie: first.cookie })).data.unreadCount, 0);
  assert.match(openedNotifications.data.notifications[0].message, /Get ready! Only 2 or fewer students ahead of you/);

  const groupmate = await register("student", "groupmate");
  const groupmateJoin = await api("/api/queue/join", {
    method: "POST", cookie: groupmate.cookie,
    body: { instructorId: instructor.user.id, reason: "assessments" },
  });
  assert.equal(
    (await api("/api/notifications/status?afterId=0", { cookie: groupmate.cookie })).data.newNotifications.filter(
      (notification) => notification.type === "ready",
    ).length,
    1,
  );
  await api("/api/notifications", { method: "DELETE", cookie: groupmate.cookie });
  await api("/api/queue/leave", {
    method: "POST", cookie: groupmate.cookie, body: { entryId: groupmateJoin.data.entryId },
  });
  await api("/api/queue/join", {
    method: "POST", cookie: groupmate.cookie,
    body: { instructorId: instructor.user.id, reason: "assessments" },
  });
  assert.equal(
    (await api("/api/notifications/status?afterId=0", { cookie: groupmate.cookie })).data.newNotifications.filter(
      (notification) => notification.type === "ready",
    ).length,
    0,
    "clearing history and rejoining the same entry does not resend its ready alert",
  );
  const firstAfterGroup = await api("/api/notifications/status?afterId=0", { cookie: first.cookie });
  assert.equal(firstAfterGroup.data.newNotifications.filter((notification) => notification.type === "ready").length, 1,
    "ready is sent only once for each student in a queue entry");
  await api("/api/queue/join", {
    method: "POST", cookie: third.cookie,
    body: { instructorId: instructor.user.id, reason: "help" },
  });
  const thirdState = await api("/api/student/state", { cookie: third.cookie });
  assert.equal(thirdState.data.queue.ahead, 3, "a group counts as its individual student members");
  assert.deepEqual(
    (await api("/api/notifications/status?afterId=0", { cookie: third.cookie })).data.newNotifications.map((notification) => notification.type),
    ["joined"],
    "a student with more than two students ahead is not readied early",
  );

  await api("/api/queue/join", {
    method: "POST", cookie: fourth.cookie,
    body: { instructorId: instructor.user.id, reason: "other", otherReason: "A follow-up question" },
  });
  const fifth = await register("student", "fifth");
  await api("/api/queue/join", {
    method: "POST", cookie: fifth.cookie,
    body: { instructorId: instructor.user.id, reason: "other", otherReason: "A follow-up question" },
  });
  const instructorQueue = await api("/api/instructor/queue", { cookie: instructor.cookie });
  assert.equal(instructorQueue.data.entries.length, 4, "Other entries are never grouped");
  assert.equal(instructorQueue.data.entries[0].students.length, 3, "matching reason group has three students");

  const paused = await api("/api/instructor/queue-status", {
    method: "PATCH", cookie: instructor.cookie, body: { status: "paused" },
  });
  assert.equal(paused.data.queueStatus, "paused");
  assert.ok((await api("/api/notifications/status?afterId=0", { cookie: third.cookie })).data.newNotifications.some(
    (notification) => notification.type === "queue_paused",
  ));
  const deniedJoin = await api("/api/queue/join", {
    method: "POST", cookie: emptyRoster.cookie,
    body: { instructorId: instructor.user.id, reason: "help" },
  });
  assert.equal(deniedJoin.status, 409, "students cannot join a paused queue");
  assert.equal((await api("/api/instructors", { cookie: first.cookie })).data.instructors[0].waitingCount, 6);

  await api("/api/instructor/queue-status", {
    method: "PATCH", cookie: instructor.cookie, body: { status: "open" },
  });
  assert.ok((await api("/api/notifications/status?afterId=0", { cookie: third.cookie })).data.newNotifications.some(
    (notification) => notification.type === "queue_resumed",
  ));
  const called = await api("/api/instructor/next", { method: "POST", cookie: instructor.cookie, body: {} });
  assert.equal(called.status, 200);
  assert.equal(called.data.entries[0].status, "in_office");
  const calledStudent = await api("/api/student/state", { cookie: first.cookie });
  assert.equal(calledStudent.data.queue.entryStatus, "in_office");
  const thirdNotifications = await api("/api/notifications/status?afterId=0", { cookie: third.cookie });
  assert.ok(thirdNotifications.data.newNotifications.some((notification) => notification.type === "ready"),
    "a group leaving the line can move someone from three ahead to zero");
  assert.equal(thirdNotifications.data.newNotifications.filter((notification) => notification.type === "ready").length, 1);
  const calledGroupNotifications = await api("/api/notifications/status?afterId=0", { cookie: first.cookie });
  const groupTurn = calledGroupNotifications.data.newNotifications.find((notification) => notification.type === "turn");
  assert.match(groupTurn.message, /group for Discuss Assessments/,
    "students called as a group receive the group-specific turn notification");

  await api("/api/instructor/queue-status", {
    method: "PATCH", cookie: instructor.cookie, body: { status: "closed" },
  });
  const removedStudent = await api("/api/student/state", { cookie: third.cookie });
  assert.equal(removedStudent.data.queue, null);
  assert.equal(removedStudent.data.notice.type, "cancelled");
  assert.ok((await api("/api/notifications/status?afterId=0", { cookie: third.cookie })).data.newNotifications.some(
    (notification) => notification.type === "queue_closed",
  ));

  const relogin = await api("/api/auth/login", {
    method: "POST",
    body: { role: "student", email: "student-first@example.edu", password: "secure-test-password-123" },
  });
  assert.ok((await api("/api/notifications/status", { cookie: relogin.cookie })).data.unreadCount > 0,
    "unread notifications persist across separate sessions");

  await api("/api/notifications", { method: "DELETE", cookie: first.cookie });
  assert.equal((await api("/api/notifications/status", { cookie: first.cookie })).data.unreadCount, 0);
  assert.ok((await api("/api/notifications/status", { cookie: second.cookie })).data.unreadCount > 0,
    "clearing one student's notifications does not clear another student's history");
});

test("passwords are hashed and logins are role-scoped", async () => {
  const stored = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("student-first@example.edu");
  assert.ok(stored.password_hash.includes(":"));
  assert.notEqual(stored.password_hash, "secure-test-password-123");

  const wrongRole = await api("/api/auth/login", {
    method: "POST",
    body: { role: "instructor", email: "student-first@example.edu", password: "secure-test-password-123" },
  });
  assert.equal(wrongRole.status, 401);

  const login = await api("/api/auth/login", {
    method: "POST",
    body: { role: "student", email: "student-first@example.edu", password: "secure-test-password-123" },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "student");
});
