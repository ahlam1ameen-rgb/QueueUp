const root = document.querySelector("#app");
const toastEl = document.querySelector("#toast");
const notificationBannerEl = document.querySelector("#notification-banner");
const REASONS = [
  { id: "help", label: "Get Help", icon: "✦", description: "A question, explanation, or topic" },
  { id: "grades", label: "View or Discuss Grades", icon: "↗" },
  { id: "assessments", label: "Discuss Assessments", icon: "▤" },
  { id: "attendance", label: "Discuss Attendance", icon: "✓" },
  { id: "other", label: "Other", icon: "＋" },
];

const state = {
  user: null,
  role: "student",
  authMode: "login",
  screen: "welcome",
  instructors: [],
  selectedInstructor: null,
  selectedReason: "",
  queue: null,
  notice: null,
  queueStatus: null,
  unreadCount: 0,
  notificationCursor: null,
  notifications: [],
  notificationBannerQueue: [],
  notificationBannerActive: false,
  notificationReturnScreen: "instructors",
  turnDismissed: false,
  polling: null,
  isPolling: false,
  toastTimer: null,
  notificationBannerTimer: null,
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error-toast", isError);
  toastEl.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
}

const notificationIcons = {
  joined: "✓",
  ready: "!",
  turn: "★",
  queue_paused: "Ⅱ",
  queue_resumed: "▶",
  queue_closed: "×",
};

function notifyBrowser(notification) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("QueueUp", { body: notification.message, icon: "/icon.svg" });
    }
  } catch {}
}

function showIncomingNotifications(notifications) {
  state.notificationBannerQueue.push(...notifications.slice(-5).reverse());
  if (!state.notificationBannerActive) showNextNotificationBanner();
}

function showNextNotificationBanner() {
  const notification = state.notificationBannerQueue.shift();
  if (!notification) {
    state.notificationBannerActive = false;
    return;
  }
  state.notificationBannerActive = true;
  if (!notificationBannerEl) return;
  const icon = notificationIcons[notification.type] || "•";
  notificationBannerEl.innerHTML = `<span class="notification-banner-icon">${icon}</span>
    <span class="notification-banner-message">${escapeHtml(notification.message)}</span>`;
  notificationBannerEl.hidden = false;
  notificationBannerEl.classList.add("visible");
  clearTimeout(state.notificationBannerTimer);
  state.notificationBannerTimer = setTimeout(() => {
    notificationBannerEl.classList.remove("visible");
    notificationBannerEl.hidden = true;
    state.notificationBannerActive = false;
    showNextNotificationBanner();
  }, 3800);
  if ("vibrate" in navigator) navigator.vibrate([120, 60, 120]);
  else playAlertTone();
  notifyBrowser(notification);
}

function playAlertTone() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audio = new AudioContextClass();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(.08, audio.currentTime);
    oscillator.start();
    oscillator.stop(audio.currentTime + .22);
    oscillator.onended = () => audio.close();
  } catch {}
}

function header(back = "", logout = false, isStudent = false) {
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark">Q</span>QueueUp</div>
    <div class="top-actions">
      ${back ? `<button class="icon-button" data-action="back" data-destination="${escapeHtml(back)}" aria-label="Go back">←</button>` : ""}
      ${isStudent ? `<button class="icon-button notification-bell" data-action="open-notifications" aria-label="Notifications${state.unreadCount ? `, ${state.unreadCount} unread` : ""}" title="Notifications">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        ${state.unreadCount ? `<span class="notification-badge">${state.unreadCount > 99 ? "99+" : state.unreadCount}</span>` : ""}
      </button>` : ""}
      ${logout ? `<button class="icon-button" data-action="logout" aria-label="Log out" title="Log out">↗</button>` : ""}
    </div>
  </header>`;
}

function shell(content, { back = "", logout = false, wide = false, student = false } = {}) {
  root.innerHTML = `<div class="app-shell ${wide ? "wide" : ""}">${header(back, logout, student)}${content}</div>
    <section class="turn-overlay" id="turnOverlay" hidden aria-modal="true" role="dialog">
      <div class="turn-content"><div class="turn-icon">✓</div><p class="eyebrow" style="color:#a9d8c4">Office hours</p>
        <h2 id="turnTitle">It’s your turn!</h2><p id="turnMessage">Go in now.</p>
        <button class="btn btn-primary" data-action="dismiss-turn" style="background:white;color:#173b70;width:100%">Got it</button>
      </div>
    </section>`;
}

function loading() {
  root.innerHTML = `<div class="app-shell"><div class="loading"><div><div class="spinner"></div>Loading QueueUp…</div></div></div>`;
}

function renderWelcome() {
  state.screen = "welcome";
  shell(`<section class="hero">
    <div class="hero-art" aria-hidden="true"><div class="queue-visual"><span class="queue-dot"></span><span class="queue-dot"></span><span class="queue-dot"></span><span class="queue-arrow">→</span><span class="queue-dot"></span></div></div>
    <p class="eyebrow">Office hours, made simple</p>
    <h1>Get help.<br>Skip the wait.</h1>
    <p class="subtitle">Join your instructor’s queue and know when it’s your turn. No hallway guessing required.</p>
    <div class="button-stack">
      <button class="btn btn-primary" data-action="choose-role" data-role="student">I’m a Student <span aria-hidden="true">→</span></button>
      <button class="btn btn-secondary" data-action="choose-role" data-role="instructor">I’m an Instructor <span aria-hidden="true">→</span></button>
    </div>
  </section>`);
}

function renderAuth() {
  state.screen = "auth";
  const instructor = state.role === "instructor";
  const signup = state.authMode === "signup";
  shell(`<section class="auth-card">
    <div class="role-switch">
      <button class="role-option ${!instructor ? "active" : ""}" data-action="role-tab" data-role="student">Student</button>
      <button class="role-option ${instructor ? "active" : ""}" data-action="role-tab" data-role="instructor">Instructor</button>
    </div>
    <p class="eyebrow">${instructor ? "For instructors" : "For students"}</p>
    <h2>${signup ? "Create your account" : "Welcome back"}</h2>
    <p class="subtitle">${signup ? `Join QueueUp as a ${state.role}.` : "Log in to continue to your queue."}</p>
    <form id="authForm" class="form-grid" novalidate>
      ${signup ? `<label class="field">Full name<input name="fullName" autocomplete="name" maxlength="100" placeholder="Your full name" required></label>` : ""}
      ${signup && !instructor ? `<label class="field">Student ID<input name="studentId" autocomplete="off" maxlength="40" placeholder="Your student ID" required></label>` : ""}
      <label class="field">Email address<input type="email" name="email" autocomplete="email" maxlength="254" placeholder="you@university.edu" required></label>
      <label class="field">Password<input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? 10 : 1}" maxlength="200" placeholder="${signup ? "At least 10 characters" : "Your password"}" required></label>
      ${signup && instructor ? `<label class="field">Office location<input name="officeLocation" maxlength="160" placeholder="Building C, Room 214" required></label>` : ""}
      <p class="form-error" id="formError" role="alert"></p>
      <button class="btn btn-primary" type="submit">${signup ? "Create account" : "Log in"}</button>
    </form>
    <p class="auth-toggle">${signup ? "Already have an account?" : "New to QueueUp?"}
      <button class="text-button" data-action="toggle-auth">${signup ? "Log in" : "Sign up"}</button>
    </p>
  </section>`, { back: "welcome" });
}

function statusPill(status) {
  const label = status === "open" ? "Open" : status === "paused" ? "Paused" : "Closed";
  return `<span class="status-pill status-${status}">${label}</span>`;
}

function initials(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function renderInstructors() {
  state.screen = "instructors";
  const cards = state.instructors.length
    ? state.instructors.map((instructor) => `
      <button class="instructor-card" data-action="select-instructor" data-id="${instructor.id}" ${instructor.queueStatus !== "open" ? "disabled" : ""}>
        <span class="avatar">${escapeHtml(initials(instructor.fullName))}</span>
        <span class="instructor-info"><h3>${escapeHtml(instructor.fullName)}</h3><p>${escapeHtml(instructor.officeLocation)}</p></span>
        <span class="card-right">${statusPill(instructor.queueStatus)}<span class="waiting-count">${instructor.waitingCount} waiting</span></span>
      </button>`).join("")
    : `<div class="empty-state"><div class="empty-icon">⌕</div><h3>No instructors yet</h3><p>When instructors create QueueUp accounts, they’ll appear here.</p></div>`;
  shell(`<div class="heading-row"><div><p class="eyebrow">Hi, ${escapeHtml(state.user.fullName.split(" ")[0])}</p><h2>Find your instructor</h2><p class="muted" style="margin:0">Choose an open office-hours queue.</p></div></div>
    ${state.notice ? `<div class="banner warning">${escapeHtml(state.notice.text)}</div>` : ""}
    <section class="instructor-list">${cards}</section>`, { logout: true, student: true });
}

function renderReason() {
  state.screen = "reason";
  const instructor = state.selectedInstructor;
  shell(`<p class="eyebrow">New queue visit</p><h2>What can they help with?</h2>
    <p class="subtitle">Choosing a reason helps your instructor group similar questions.</p>
    <div class="info-card" style="margin-bottom:18px"><div class="info-line"><strong>${escapeHtml(instructor.fullName)}</strong></div><div class="info-line">⌖ ${escapeHtml(instructor.officeLocation)}</div></div>
    <p class="section-label">Choose a reason</p>
    <div class="reason-list">${REASONS.map((reason) => `
      <button class="reason-option ${state.selectedReason === reason.id ? "selected" : ""}" data-action="select-reason" data-reason="${reason.id}">
        <span class="reason-icon">${reason.icon}</span><span class="reason-text">${reason.label}</span><span class="reason-check">${state.selectedReason === reason.id ? "✓" : ""}</span>
      </button>`).join("")}</div>
    ${state.selectedReason === "other" ? `<label class="field other-field">Tell us a little more<input id="otherReason" maxlength="300" placeholder="What would you like to discuss?" required></label>` : ""}
    <p class="form-error ${state.reasonError ? "show" : ""}" id="reasonError">${escapeHtml(state.reasonError || "")}</p>
    <button class="btn btn-primary" data-action="join-queue" style="width:100%;margin-top:18px" ${state.selectedReason ? "" : "disabled"}>Join queue <span aria-hidden="true">→</span></button>`, { back: "instructors", logout: true, student: true });
}

function renderStudentQueue() {
  state.screen = "queue";
  const queue = state.queue;
  if (!queue) return renderInstructors();
  const inOffice = queue.entryStatus === "in_office";
  const groupLabel = queue.groupSize > 1
    ? `You’re in a group of ${queue.groupSize} for ${queue.reasonLabel}`
    : queue.reasonLabel;
  let alertText = "";
  let alertClass = "";
  if (queue.queueStatus === "paused") {
    alertText = "This queue is paused. You’re still in line, but no new students can join.";
    alertClass = "warning";
  } else if (queue.queueStatus === "closed" && !inOffice) {
    alertText = "This queue is closed. Your place is no longer active.";
    alertClass = "warning";
  } else if (queue.ahead <= 2 && !inOffice) {
    alertText = `Get ready! Only 2 or fewer students ahead of you. Head to ${queue.officeLocation}.`;
  }
  shell(`<p class="eyebrow">Your place in line</p><h2>Live queue</h2>
    ${alertText ? `<div class="banner ${alertClass}">${escapeHtml(alertText)}</div>` : ""}
    ${inOffice && !state.turnDismissed ? `<div class="banner success">It’s your turn! Go in now.</div>` : ""}
    <div class="queue-hero ${inOffice ? "in-office" : ""}">
      <p class="eyebrow" style="color:#dbe9fb">${inOffice ? "You’ve been called" : "Your position"}</p>
      <div class="number">${inOffice ? "✓" : queue.ahead}</div>
      <p class="ahead-label">${inOffice ? "It’s your turn!" : `${queue.ahead === 1 ? "student" : "students"} ahead of you`}</p>
    </div>
    <div class="info-card">
      <div class="info-line"><strong>${escapeHtml(queue.instructorName)}</strong></div>
      <div class="info-line">⌖ ${escapeHtml(queue.officeLocation)}</div>
      <div class="info-line">◷ Queue ${statusPill(queue.queueStatus)}</div>
      <div class="info-line">◎ ${escapeHtml(groupLabel)}</div>
      ${queue.reason === "other" ? `<div class="info-line">“${escapeHtml(queue.otherReason)}”</div>` : ""}
    </div>
    ${queue.queueStatus === "closed" && !inOffice ? `<button class="btn btn-secondary" data-action="back" data-destination="instructors" style="width:100%;margin-top:16px">Back to instructors</button>` : `<button class="btn btn-quiet" data-action="leave-queue" style="width:100%;margin-top:16px">Leave queue</button>`}
    <div class="turn-overlay" id="turnOverlay" ${inOffice && !state.turnDismissed ? "" : "hidden"} aria-modal="true" role="dialog">
      <div class="turn-content"><div class="turn-icon">✓</div><p class="eyebrow" style="color:#a9d8c4">Office hours</p>
        <h2>${queue.groupSize > 1 ? "Your group has been called" : "It’s your turn!"}</h2>
        <p>${queue.groupSize > 1 ? `You’ve been called in with your group for ${escapeHtml(queue.reasonLabel)}.` : "Go in now."}<br>${escapeHtml(queue.officeLocation)}</p>
        <button class="btn btn-primary" data-action="dismiss-turn" style="background:white;color:#173b70;width:100%">Got it</button>
      </div>
    </div>`, { logout: true, student: true });
}

function relativeTime(value) {
  const normalized = String(value || "").replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (!Number.isFinite(seconds) || seconds < 45) return "just now";
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hr ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function browserNotificationSettings() {
  if (!("Notification" in window)) {
    return `<div class="push-setting"><span><strong>Browser alerts unavailable</strong><small>Your in-app bell and banners still work.</small></span></div>`;
  }
  if (Notification.permission === "granted") {
    return `<div class="push-setting"><span><strong>Browser alerts enabled</strong><small>Browser alerts appear while QueueUp is open; the in-app bell is always available.</small></span><span class="permission-check">✓</span></div>`;
  }
  if (Notification.permission === "denied") {
    return `<div class="push-setting"><span><strong>Browser alerts are blocked</strong><small>Allow notifications in browser settings. The in-app bell and banners still work.</small></span></div>`;
  }
  return `<div class="push-setting"><span><strong>Enable browser alerts</strong><small>Optional browser pop-ups while QueueUp is open.</small></span><button class="btn btn-secondary btn-small" data-action="enable-browser-notifications">Enable notifications</button></div>`;
}

function renderNotifications() {
  state.screen = "notifications";
  const cards = state.notifications.length
    ? state.notifications.map((notification) => `
      <article class="notification-item ${notification.wasUnread ? "unread" : ""}">
        <span class="notification-icon ${escapeHtml(notification.type)}">${notificationIcons[notification.type] || "•"}</span>
        <span class="notification-item-content">
          <span class="notification-message">${escapeHtml(notification.message)}</span>
          <time datetime="${escapeHtml(notification.createdAt)}">${relativeTime(notification.createdAt)}</time>
        </span>
        ${notification.wasUnread ? `<span class="notification-unread-dot" aria-label="Unread"></span>` : ""}
      </article>`).join("")
    : `<div class="empty-state"><div class="empty-icon">♧</div><h3>You’re all caught up</h3><p>Queue updates and reminders will show up here.</p></div>`;
  shell(`<div class="heading-row notification-heading">
      <div><p class="eyebrow">Your updates</p><h2>Notifications</h2></div>
      <button class="text-button" data-action="clear-notifications" ${state.notifications.length ? "" : "disabled"}>Clear all</button>
    </div>
    ${browserNotificationSettings()}
    <section class="notification-list" aria-label="Your notifications">${cards}</section>`, {
    back: state.notificationReturnScreen,
    logout: true,
    student: true,
  });
}

function renderInstructorDashboard() {
  state.screen = "dashboard";
  const entries = state.entries || [];
  const inOffice = entries.find((entry) => entry.status === "in_office");
  const waiting = entries.filter((entry) => entry.status === "waiting");
  const entryCards = entries.map((entry, index) => {
    const called = entry.status === "in_office";
    const position = called ? "✓" : index - (inOffice ? 1 : 0) + 1;
    return `<article class="queue-card ${called ? "in-office-card" : ""}">
      <div class="entry-top"><span class="position">${position}</span>
        <div class="entry-main">
          <h3>${called ? "In Office" : entry.students.length > 1 ? `${entry.students.length} students` : escapeHtml(entry.students[0]?.fullName || "Student")}</h3>
          ${entry.reason === "other" ? `<span class="reason-tag other">Other</span>` : `<span class="reason-tag ${entry.reason}">${escapeHtml(entry.reasonLabel)}</span>`}
          ${entry.reason === "other" ? `<p style="margin-top:7px">${escapeHtml(entry.otherReason)}</p>` : ""}
          ${entry.students.length > 1 ? `<p class="student-names">${entry.students.map((student) => `${escapeHtml(student.fullName)}${student.studentId ? ` · ${escapeHtml(student.studentId)}` : ""}`).join("<br>")}</p>` : `<p style="margin-top:7px">${escapeHtml(entry.students[0]?.studentId || "")}</p>`}
        </div>
      </div>
    </article>`;
  }).join("");
  const stateText = state.queueStatus === "open" ? "Students can join your queue." : state.queueStatus === "paused" ? "Students in line will stay; new students can’t join." : "Open your queue when office hours begin.";
  const controls = state.queueStatus === "closed"
    ? `<button class="btn btn-primary" data-action="set-status" data-status="open">Open queue</button>`
    : state.queueStatus === "paused"
      ? `<button class="btn btn-primary" data-action="set-status" data-status="open">Resume queue</button><button class="btn btn-quiet" data-action="set-status" data-status="closed">Close queue</button>`
      : `<button class="btn btn-primary" data-action="set-status" data-status="paused">Pause queue</button><button class="btn btn-quiet" data-action="set-status" data-status="closed">Close queue</button>`;
  shell(`<p class="eyebrow">Instructor dashboard</p><div class="heading-row"><div><h2>Your office hours</h2><p class="muted" style="margin:0">${escapeHtml(state.user.officeLocation)}</p></div>${statusPill(state.queueStatus)}</div>
    <div class="panel" style="margin-bottom:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div><h3>Queue controls</h3><p class="muted" style="margin:0;font-size:13px">${stateText}</p></div><span class="avatar green">${waiting.reduce((n, entry) => n + entry.students.length, 0)}</span></div>
      <div class="controls">${controls}</div>
    </div>
    <div class="heading-row"><div><p class="eyebrow" style="margin-bottom:4px">Live line</p><h2 style="font-size:22px">${waiting.length} ${waiting.length === 1 ? "entry" : "entries"} waiting</h2></div></div>
    ${entries.length ? `<section class="entry-list">${entryCards}</section>` : `<div class="empty-state"><div class="empty-icon">☷</div><h3>Your queue is clear</h3><p>Students will appear here when they join. QueueUp groups matching reasons automatically.</p></div>`}
    <button class="btn btn-primary" data-action="next" style="width:100%;margin-top:16px" ${waiting.length ? "" : "disabled"}>Call next <span aria-hidden="true">→</span></button>
    ${state.queueStatus !== "closed" ? `<button class="text-button" data-action="close-queue" style="display:block;margin:13px auto 0">Close office hours</button>` : ""}`, { logout: true, wide: true });
}

function renderCurrentScreen() {
  if (state.screen === "queue") renderStudentQueue();
  else if (state.screen === "instructors") renderInstructors();
  else if (state.screen === "reason") renderReason();
  else if (state.screen === "notifications") renderNotifications();
  else renderInstructorDashboard();
}

async function poll() {
  if (!state.user || state.isPolling) return;
  state.isPolling = true;
  try {
    if (state.user.role === "student") {
      const [data, instructorsData, notificationStatus] = await Promise.all([
        request("/api/student/state"),
        request("/api/instructors"),
        request(`/api/notifications/status?afterId=${state.notificationCursor || 0}`),
      ]);
      state.queue = data.queue;
      state.notice = data.notice;
      state.instructors = instructorsData.instructors;
      if (state.notificationCursor === null) {
        state.notificationCursor = notificationStatus.latestId;
      } else {
        const newlyArrived = notificationStatus.newNotifications.filter(
          (notification) => notification.id > state.notificationCursor,
        );
        if (newlyArrived.length) {
          state.notificationCursor = Math.max(...newlyArrived.map((notification) => notification.id));
          showIncomingNotifications(newlyArrived);
          if (state.screen === "notifications") {
            const list = await request("/api/notifications");
            state.notifications = list.notifications;
            notificationStatus.unreadCount = 0;
            state.notificationCursor = Math.max(
              state.notificationCursor,
              ...list.notifications.map((notification) => notification.id),
            );
          }
        }
      }
      state.unreadCount = notificationStatus.unreadCount;
      updateNotificationBadge();
      if (["queue", "instructors", "notifications"].includes(state.screen)) renderCurrentScreen();
    } else {
      const data = await request("/api/instructor/queue");
      const changed = state.queueStatus && state.queueStatus !== data.queueStatus;
      state.queueStatus = data.queueStatus;
      state.entries = data.entries;
      if (changed) showToast(data.queueStatus === "paused" ? "Queue paused." : data.queueStatus === "closed" ? "Queue closed." : "Queue is open.");
      if (state.screen === "dashboard") renderInstructorDashboard();
    }
  } catch (error) {
    if (error.message.includes("log in")) {
      stopPolling();
      state.user = null;
      renderWelcome();
    }
  } finally {
    state.isPolling = false;
  }
}

function startPolling() {
  stopPolling();
  poll();
  state.polling = setInterval(poll, 2500);
}

function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

async function enterApp(user) {
  state.user = user;
  state.notice = null;
  state.selectedReason = "";
  if (user.role === "student") {
    const [queueData, instructorsData, notificationStatus] = await Promise.all([
      request("/api/student/state"),
      request("/api/instructors"),
      request("/api/notifications/status?afterId=0"),
    ]);
    state.queue = queueData.queue;
    state.notice = queueData.notice;
    state.instructors = instructorsData.instructors;
    state.unreadCount = notificationStatus.unreadCount;
    state.notificationCursor = notificationStatus.latestId;
    state.screen = state.queue ? "queue" : "instructors";
  } else {
    const data = await request("/api/instructor/queue");
    state.queueStatus = data.queueStatus;
    state.entries = data.entries;
    state.screen = "dashboard";
  }
  renderCurrentScreen();
  startPolling();
}

function updateNotificationBadge() {
  const bell = document.querySelector('[data-action="open-notifications"]');
  if (!bell) return;
  const count = state.unreadCount;
  bell.setAttribute("aria-label", `Notifications${count ? `, ${count} unread` : ""}`);
  let badge = bell.querySelector(".notification-badge");
  if (count && !badge) {
    badge = document.createElement("span");
    badge.className = "notification-badge";
    bell.append(badge);
  }
  if (badge) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = !count;
  }
}

async function openNotifications() {
  if (state.screen !== "notifications") state.notificationReturnScreen = state.screen;
  const data = await request("/api/notifications");
  state.notifications = data.notifications;
  state.unreadCount = 0;
  if (data.notifications.length) {
    state.notificationCursor = Math.max(
      state.notificationCursor || 0,
      ...data.notifications.map((notification) => notification.id),
    );
  }
  renderNotifications();
}

root.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "choose-role" || action === "role-tab") {
      state.role = button.dataset.role;
      state.authMode = "login";
      renderAuth();
    } else if (action === "toggle-auth") {
      state.authMode = state.authMode === "login" ? "signup" : "login";
      renderAuth();
    } else if (action === "back") {
      if (state.screen === "notifications") {
        state.screen = button.dataset.destination || state.notificationReturnScreen;
        renderCurrentScreen();
      } else if (button.dataset.destination === "instructors") {
        state.queue = null;
        state.screen = "instructors";
        renderInstructors();
      } else if (state.screen === "reason") renderInstructors();
      else if (state.screen === "auth") renderWelcome();
      else if (state.user?.role === "student") {
        state.screen = state.queue ? "queue" : "instructors";
        renderCurrentScreen();
      }
    } else if (action === "open-notifications") {
      if (state.screen === "notifications") {
        state.screen = state.notificationReturnScreen;
        renderCurrentScreen();
      } else {
        await openNotifications();
      }
    } else if (action === "clear-notifications") {
      await request("/api/notifications", { method: "DELETE" });
      state.notifications = [];
      state.unreadCount = 0;
      renderNotifications();
    } else if (action === "enable-browser-notifications") {
      if (!("Notification" in window)) {
        showToast("Browser notifications are not supported here.");
      } else {
        await Notification.requestPermission();
        renderNotifications();
        if (Notification.permission === "granted") showToast("Browser notifications enabled.");
        else showToast("In-app notifications will continue to work.");
      }
    } else if (action === "select-instructor") {
      state.selectedInstructor = state.instructors.find((item) => item.id === Number(button.dataset.id));
      if (state.selectedInstructor?.queueStatus === "open") {
        state.selectedReason = "";
        state.reasonError = "";
        renderReason();
      }
    } else if (action === "select-reason") {
      state.selectedReason = button.dataset.reason;
      state.reasonError = "";
      renderReason();
      if (state.selectedReason === "other") document.querySelector("#otherReason")?.focus();
    } else if (action === "join-queue") {
      const otherReason = document.querySelector("#otherReason")?.value.trim() || "";
      try {
        await request("/api/queue/join", {
          method: "POST",
          body: JSON.stringify({
            instructorId: state.selectedInstructor.id,
            reason: state.selectedReason,
            otherReason,
          }),
        });
        state.turnDismissed = false;
        await poll();
        state.screen = "queue";
        renderStudentQueue();
      } catch (error) {
        state.reasonError = error.message;
        renderReason();
      }
    } else if (action === "leave-queue") {
      if (!confirm("Leave this queue?")) return;
      await request("/api/queue/leave", { method: "POST", body: JSON.stringify({ entryId: state.queue.entryId }) });
      state.queue = null;
      state.screen = "instructors";
      await poll();
      renderInstructors();
    } else if (action === "dismiss-turn") {
      state.turnDismissed = true;
      document.querySelector("#turnOverlay")?.setAttribute("hidden", "");
    } else if (action === "logout") {
      stopPolling();
      await request("/api/auth/logout", { method: "POST", body: "{}" });
      state.user = null;
      state.queue = null;
      state.instructors = [];
      state.notificationCursor = null;
      state.unreadCount = 0;
      renderWelcome();
    } else if (action === "set-status") {
      if (button.dataset.status === "closed" && !confirm("Close office hours and remove all waiting students?")) return;
      const data = await request("/api/instructor/queue-status", {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.status }),
      });
      state.queueStatus = data.queueStatus;
      state.entries = data.entries;
      renderInstructorDashboard();
    } else if (action === "close-queue") {
      if (!confirm("Close office hours and remove all waiting students?")) return;
      const data = await request("/api/instructor/queue-status", { method: "PATCH", body: JSON.stringify({ status: "closed" }) });
      state.queueStatus = data.queueStatus;
      state.entries = data.entries;
      renderInstructorDashboard();
    } else if (action === "next") {
      const data = await request("/api/instructor/next", { method: "POST", body: "{}" });
      state.entries = data.entries;
      renderInstructorDashboard();
    }
  } catch (error) {
    showToast(error.message, true);
  }
});

root.addEventListener("submit", async (event) => {
  if (event.target.id !== "authForm") return;
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.role = state.role;
  const errorEl = document.querySelector("#formError");
  const submit = event.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const endpoint = state.authMode === "signup" ? "/api/auth/register" : "/api/auth/login";
    const data = await request(endpoint, { method: "POST", body: JSON.stringify(payload) });
    await enterApp(data.user);
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = error.message;
      errorEl.classList.add("show");
    }
    submit.disabled = false;
  }
});

async function boot() {
  loading();
  try {
    const data = await request("/api/auth/session");
    if (data.user) await enterApp(data.user);
    else renderWelcome();
  } catch {
    renderWelcome();
    showToast("Couldn’t connect to QueueUp. Refresh to try again.", true);
  }
}

boot();
