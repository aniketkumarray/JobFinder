/* ============================================================
   AutoMatch AI — application logic
   Everything runs locally. Applications persist in localStorage.
   ============================================================ */

(() => {
  "use strict";

  const JOBS = window.AUTOMATCH_JOBS || [];
  const DEFAULT_RESUME = window.AUTOMATCH_DEFAULT_RESUME;
  const KEYWORD_BANK = window.AUTOMATCH_KEYWORDS || [];
  const STORAGE_KEY = "automatch-ai.prototype.v1";

  const STATUSES = [
    { id: "saved", label: "Saved", color: "#8c8272" },
    { id: "tailored", label: "Tailored", color: "#c9a14a" },
    { id: "applied", label: "Applied", color: "#e8c77a" },
    { id: "interviewing", label: "Interviewing", color: "#f0b45e" },
    { id: "rejected", label: "Rejected", color: "#e6907f" },
    { id: "offer", label: "Offer", color: "#b4cb92" },
  ];
  const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
  const APPLIED_STATUSES = new Set(["applied", "interviewing", "rejected", "offer"]);
  const ENGINE_DEFAULTS = {
    demo: "automatch-local-v1",
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-sonnet-latest",
    freellmapi: "auto",
  };
  const FREELLMAPI_DEFAULT_URL = "http://localhost:3001/v1";
  const LEGACY_SAMPLE_EMAIL = "aarav.mehta@example.com";
  const ENGINE_LABELS = {
    demo: "On-device fallback",
    openai: "OpenAI · your key",
    anthropic: "Anthropic · your key",
    freellmapi: "FreeLLMAPI · your key",
  };

  const allJobs = () => [...(state.imported || []), ...JOBS];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  const icon = (name, className = "") =>
    `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const list = (items) => {
    if (!items.length) return "";
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  };

  const defaultState = () => ({
    applications: [],
    imported: [],
    resume: clone(DEFAULT_RESUME),
    prefs: { role: "", location: "", experience: "", remote: false, keywords: "" },
    ai: {
      provider: "freellmapi",
      model: ENGINE_DEFAULTS.freellmapi,
      keys: { openai: "", anthropic: "", freellmapi: "" },
      baseUrl: FREELLMAPI_DEFAULT_URL,
    },
    filters: { tag: "All", sort: "match" },
  });

  function loadState() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      const imported = Array.isArray(parsed.imported)
        ? parsed.imported.filter((job) => job && typeof job.id === "string" && typeof job.url === "string")
        : [];
      const knownJobs = new Set([...imported, ...JOBS].map((job) => job.id));
      const ai = {
        ...base.ai,
        ...(parsed.ai || {}),
        keys: { ...base.ai.keys, ...((parsed.ai && parsed.ai.keys) || {}) },
      };
      if (!ai.provider || ai.provider === "demo") {
        ai.provider = base.ai.provider;
        ai.model = base.ai.model;
      }
      let resume = parsed.resume && typeof parsed.resume === "object" ? parsed.resume : base.resume;
      if (resume.email === LEGACY_SAMPLE_EMAIL) resume = base.resume;
      return {
        applications: Array.isArray(parsed.applications)
          ? parsed.applications.filter((app) => app && typeof app.jobId === "string" && knownJobs.has(app.jobId))
          : [],
        imported,
        resume,
        prefs: { ...base.prefs, ...(parsed.prefs || {}) },
        ai,
        filters: { ...base.filters, ...(parsed.filters || {}) },
      };
    } catch (error) {
      console.warn("AutoMatch: could not restore state", error);
      return base;
    }
  }

  let state = loadState();
  let currentView = "search";
  let resumeRevision = 0;
  let analysisCache = new Map();
  let currentTailor = null;
  let currentTrackJobId = null;
  let generationToken = 0;
  let dragJustEnded = false;

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn("AutoMatch: could not persist state", error);
    }
  }

  function getApp(jobId) {
    return state.applications.find((app) => app.jobId === jobId);
  }

  function ensureApp(jobId, status = "saved") {
    let app = getApp(jobId);
    if (!app) {
      const now = Date.now();
      app = {
        id: `app_${jobId}`,
        jobId,
        status,
        createdAt: now,
        updatedAt: now,
        notes: "",
        attachment: "",
        tailored: null,
        appliedAt: null,
      };
      state.applications.push(app);
    }
    return app;
  }

  function isAppliedStatus(status) {
    return APPLIED_STATUSES.has(status);
  }

  function touchApp(app) {
    app.updatedAt = Date.now();
  }

  function setStatus(jobId, status) {
    const app = ensureApp(jobId);
    app.status = status;
    if (status === "applied" && !app.appliedAt) app.appliedAt = Date.now();
    touchApp(app);
    saveState();
    renderJobs();
    renderDashboard();
    updateChrome();
  }

  const timeAgo = (timestamp) => {
    if (!timestamp) return "—";
    const diff = Date.now() - new Date(timestamp).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return formatDate(timestamp);
  };

  function formatDate(timestamp) {
    if (!timestamp) return "—";
    return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(timestamp));
  }

  function postedLabel(hours) {
    if (hours < 1) return "just now";
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function shade(hex, factor) {
    const clean = String(hex).replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const channels = [0, 2, 4].map((i) => Math.round(parseInt(full.slice(i, i + 2), 16) * factor));
    return `rgb(${channels.join(", ")})`;
  }

  function logoStyle(job) {
    const [a, b] = job.brand || ["#3b3226", "#1c1917"];
    return `--logo-bg: linear-gradient(135deg, ${shade(a, 0.67)}, ${shade(b, 0.5)})`;
  }

  function salaryValue(salary) {
    const values = String(salary).match(/\d+/g);
    return values ? Math.max(...values.map(Number)) : 0;
  }

  function resumeText(resume = state.resume) {
    const parts = [
      resume.name,
      resume.title,
      resume.summary,
      ...(resume.skills || []),
      ...(resume.experience || []).flatMap((role) => [
        role.company,
        role.title,
        role.location,
        ...(role.bullets || []),
      ]),
      ...(resume.education || []).flatMap((edu) => [edu.school, edu.degree]),
      ...(resume.certifications || []),
    ];
    return parts.filter(Boolean).join(" \n ");
  }

  function termMatches(text, term) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}(?=[^a-z0-9]|$)`, "gi");
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
  }

  function keywordInText(text, entry) {
    return entry.terms.some((term) => termMatches(text, term) > 0);
  }

  function analyzeJob(job) {
    const cacheKey = `${job.id}:${resumeRevision}`;
    if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey);

    const jdText = `${job.title} ${job.company} ${(job.skills || []).join(" ")} ${job.description} ${job.category}`.toLowerCase();
    const masterText = resumeText().toLowerCase();

    const required = KEYWORD_BANK.map((entry) => ({
      label: entry.label,
      terms: entry.terms,
      count: entry.terms.reduce((total, term) => total + termMatches(jdText, term), 0),
    }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 18);

    const matched = required.filter((entry) => keywordInText(masterText, entry));
    const missing = required.filter((entry) => !keywordInText(masterText, entry));

    const titleWords = job.title.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 3);
    const resumeTitleWords = (state.resume.title || "").toLowerCase().split(/[^a-z]+/);
    const overlaps = titleWords.filter((word) => resumeTitleWords.includes(word)).length;
    const titleBonus = overlaps >= 2 ? 5 : overlaps === 1 ? 2 : 0;
    const coverage = required.length ? matched.length / required.length : 0.72;
    const score = clamp(Math.round(54 + coverage * 40 + titleBonus), 48, 98);

    const analysis = {
      required,
      matched,
      missing,
      coverage,
      titleBonus,
      score,
    };
    analysisCache.set(cacheKey, analysis);
    return analysis;
  }

  function resumeHasLabel(label) {
    const entry = KEYWORD_BANK.find((item) => item.label === label);
    if (!entry) return false;
    return keywordInText(resumeText().toLowerCase(), entry);
  }

  function emphasize(text, labels) {
    const terms = [];
    labels.forEach((label) => {
      const entry = KEYWORD_BANK.find((item) => item.label === label);
      if (entry) terms.push(...entry.terms);
      terms.push(label);
    });
    const unique = Array.from(new Set(terms.filter(Boolean))).sort((a, b) => b.length - a.length);
    if (!unique.length) return escapeHtml(text);
    const pattern = new RegExp(`(${unique.map(escapeRegExp).join("|")})`, "gi");
    const set = new Set(unique.map((term) => term.toLowerCase()));
    return String(text)
      .split(pattern)
      .map((part) => (set.has(part.toLowerCase()) ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
      .join("");
  }

  function filteredJobs() {
    const role = (state.prefs.role || "").trim().toLowerCase();
    const location = (state.prefs.location || "").trim().toLowerCase();
    const experience = state.prefs.experience || "";
    const remoteOnly = Boolean(state.prefs.remote);
    const tag = state.filters.tag || "All";
    const roleTokens = role.split(/\s+/).filter(Boolean);
    const locationTokens = location.split(/[\/,;]|\bor\b/i).map((token) => token.trim()).filter(Boolean);

    const jobs = allJobs().filter((job) => {
      const haystack = `${job.title} ${job.company} ${job.location} ${job.category} ${job.team} ${(job.skills || []).join(" ")} ${job.description}`.toLowerCase();
      if (roleTokens.length && !roleTokens.every((token) => haystack.includes(token))) return false;

      if (locationTokens.length) {
        const matchesLocation = locationTokens.some((token) => {
          if (token === "remote") return job.remote;
          return job.location.toLowerCase().includes(token);
        });
        if (!matchesLocation) return false;
      }

      if (remoteOnly && !job.remote) return false;
      if (experience && job.experience !== experience) return false;

      if (tag !== "All") {
        if (tag === "Remote" && !job.remote) return false;
        if (tag === "Fintech" && job.category !== "Fintech") return false;
        if (tag === "AI/ML" && job.category !== "AI/ML") return false;
        if (tag === "Product" && !/product manager/i.test(job.title)) return false;
        if (tag === "Analytics" && !/analyst/i.test(job.title)) return false;
      }
      return true;
    });

    if (state.filters.sort === "new") {
      jobs.sort((a, b) => a.postedHours - b.postedHours);
    } else if (state.filters.sort === "salary") {
      jobs.sort((a, b) => salaryValue(b.salary) - salaryValue(a.salary));
    } else {
      jobs.sort((a, b) => analyzeJob(b).score - analyzeJob(a).score);
    }
    return jobs;
  }

  function metaChip(iconName, label, extra = "") {
    return `<span class="meta-chip ${extra}">${icon(iconName)}${escapeHtml(label)}</span>`;
  }

  function jobCardHtml(job, index) {
    const analysis = analyzeJob(job);
    const app = getApp(job.id);
    const saved = Boolean(app);
    const resumeLower = resumeText().toLowerCase();
    const overlapSkills = (job.skills || []).filter(
      (skill) => resumeLower.includes(skill.toLowerCase()) || analysis.matched.some((item) => item.label === skill)
    );
    const shownSkills = (job.skills || []).slice(0, 4);
    const extraSkills = Math.max(0, (job.skills || []).length - shownSkills.length);
    const actionLabel = app && app.tailored ? "Review & apply" : "Tailor & apply";

    return `
      <article class="job-card" style="${logoStyle(job)}; --i:${Math.min(index, 8)}" data-job-id="${escapeHtml(job.id)}">
        <div class="job-card-top">
          <div class="company-logo" aria-hidden="true">${escapeHtml(job.logo)}</div>
          <div class="job-card-title">
            <h3 title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</h3>
            <p>${icon("building")}${escapeHtml(job.company)}<span class="dot-sep"></span>${escapeHtml(job.location)}</p>
          </div>
          <button class="icon-btn bookmark-btn ${saved ? "saved" : ""}" type="button"
            data-action="job-save" data-job-id="${escapeHtml(job.id)}"
            aria-label="${saved ? "Open in pipeline" : "Save role"}" aria-pressed="${saved}"
            title="${saved ? STATUS_MAP[app.status].label + " · open in pipeline" : "Save role"}">
            ${icon("bookmark")}
          </button>
        </div>

        <div class="job-meta">
          ${metaChip(job.remote ? "globe" : "briefcase", job.remote ? "Remote" : job.mode, job.remote ? "remote" : "")}
          ${metaChip("layers", job.experience)}
          ${metaChip("zap", job.salary, "salary")}
          ${metaChip("clock", postedLabel(job.postedHours))}
        </div>

        <p class="job-snippet">${escapeHtml(job.description)}</p>

        <div class="skill-row">
          ${shownSkills.map((skill) => `<span class="skill-tag ${overlapSkills.includes(skill) ? "overlap" : ""}">${escapeHtml(skill)}</span>`).join("")}
          ${extraSkills ? `<span class="skill-tag more">+${extraSkills}</span>` : ""}
        </div>

        <div class="job-card-foot">
          <span class="match-pill" title="Resume-to-JD keyword alignment">
            <span class="match-bar"><span style="width:${analysis.score}%"></span></span>
            <strong>${analysis.score}%</strong><small>match</small>
          </span>
          <button class="card-btn ai" type="button" data-action="job-tailor" data-job-id="${escapeHtml(job.id)}">
            ${icon("sparkles", "spark")}${actionLabel}
          </button>
        </div>
      </article>`;
  }

  function renderJobs() {
    const grid = $("#jobGrid");
    if (!grid) return;
    const jobs = filteredJobs();
    const count = $("#resultCount");
    if (count) count.textContent = `${jobs.length} role${jobs.length === 1 ? "" : "s"}`;
    const head = $("#headMatched");
    if (head) head.textContent = jobs.length;
    const clear = $("#clearFiltersBtn");
    if (clear) {
      clear.hidden = !(
        state.prefs.role ||
        state.prefs.location ||
        state.prefs.experience ||
        state.prefs.remote ||
        (state.filters.tag && state.filters.tag !== "All")
      );
    }

    if (!allJobs().length) {
      grid.innerHTML = `
        <div class="empty-feed">
          <div class="empty-icon">${icon("search")}</div>
          <h3>No roles yet.</h3>
          <p>Import a job posting by URL from Settings to start tailoring.</p>
          <button class="btn btn-primary" type="button" data-view="settings">${icon("settings")}Open settings</button>
        </div>`;
      return;
    }
    if (!jobs.length) {
      grid.innerHTML = `
        <div class="empty-feed">
          <div class="empty-icon">${icon("search")}</div>
          <h3>No roles match that search yet.</h3>
          <p>Try a broader title, clear the location, or reset the quick filters.</p>
          <button class="btn btn-primary" type="button" data-action="clear-filters">${icon("refresh")}Reset filters</button>
        </div>`;
      return;
    }
    grid.innerHTML = jobs.map((job, index) => jobCardHtml(job, index)).join("");
  }

  function statusCounts() {
    const counts = Object.fromEntries(STATUSES.map((status) => [status.id, 0]));
    state.applications.forEach((app) => {
      if (counts[app.status] !== undefined) counts[app.status] += 1;
    });
    return counts;
  }

  function updateChrome() {
    const apps = state.applications;
    const counts = statusCounts();
    const navCount = $("#navAppCount");
    if (navCount) navCount.textContent = apps.length;

    const mini = $("#miniPipeline");
    if (mini) {
      mini.innerHTML = STATUSES.map((status) => `
        <div class="mini-pipe-row" data-status="${status.id}">
          <span class="mini-pipe-dot"></span>
          <span>${status.label}</span>
          <strong>${counts[status.id] || 0}</strong>
        </div>`).join("");
    }

    const tailored = apps.filter((app) => app.tailored).length;
    const sent = apps.filter((app) => isAppliedStatus(app.status));
    const currentWeek = sent.filter((app) => app.appliedAt && Date.now() - app.appliedAt < 7 * 86_400_000).length;

    if ($("#headTailored")) $("#headTailored").textContent = tailored;
    if ($("#headApplied")) $("#headApplied").textContent = sent.length;

    const bar = $("#weeklyBar");
    const label = $("#weeklyLabel");
    const hint = $("#weeklyHint");
    if (bar) bar.style.width = `${clamp(Math.round((currentWeek / 5) * 100), 0, 100)}%`;
    if (label) label.textContent = `${currentWeek} of 5 applications`;
    if (hint) {
      hint.textContent = currentWeek >= 5
        ? "Goal hit. Keep the momentum going."
        : currentWeek > 0
          ? `${5 - currentWeek} more to hit this week's goal.`
          : "Tailor your first role to get moving.";
    }

    if ($("#profileName")) $("#profileName").textContent = state.resume.name || "Your name";
    if ($("#profileTitle")) $("#profileTitle").textContent = state.resume.title || "Your title";
    const initials = (state.resume.name || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "Me";
    $$("[data-initials]").forEach((el) => { el.textContent = initials; });

    const hints = {
      search: `${filteredJobs().length} role${filteredJobs().length === 1 ? "" : "s"}`,
      dashboard: `${apps.length} tracked application${apps.length === 1 ? "" : "s"}`,
      settings: "Resume & AI workspace",
    };
    const hintEl = $("#topbarHint");
    if (hintEl) hintEl.textContent = hints[currentView] || "";
  }

  function renderResumeOverview() {
    const wrap = $("#resumeOverview");
    if (!wrap) return;
    const resume = state.resume;
    const bullets = (resume.experience || []).reduce((total, role) => total + (role.bullets || []).length, 0);
    wrap.innerHTML = `
      <div class="resume-identity">
        <div class="resume-name">${escapeHtml(resume.name || "Your name")}</div>
        <div class="resume-title">${escapeHtml(resume.title || "Target title")}</div>
        <div class="resume-contact">
          <span>${icon("mail")}${escapeHtml(resume.email || "Add an email")}</span>
          <span>${icon("phone")}${escapeHtml(resume.phone || "Add a phone")}</span>
          <span>${icon("map-pin")}${escapeHtml(resume.location || "Add a location")}</span>
          ${resume.website ? `<span>${icon("globe")}${escapeHtml(resume.website)}</span>` : ""}
        </div>
      </div>
      <div>
        <div class="resume-section-label">Professional summary</div>
        <p class="resume-summary">${escapeHtml(resume.summary || "No summary yet.")}</p>
        <div class="resume-stats">
          <div><strong>${(resume.experience || []).length}</strong><small>roles</small></div>
          <div><strong>${bullets}</strong><small>bullets</small></div>
          <div><strong>${(resume.skills || []).length}</strong><small>skills</small></div>
        </div>
      </div>
      <div>
        <div class="resume-section-label">Core skills</div>
        <div class="skill-cloud">
          ${(resume.skills || []).slice(0, 18).map((skill) => `<span>${escapeHtml(skill)}</span>`).join("")}
        </div>
      </div>`;
  }

  function renderDashboard() {
    const statsWrap = $("#dashboardStats");
    const board = $("#kanbanBoard");
    if (!statsWrap || !board) return;

    const apps = state.applications;
    const counts = statusCounts();
    const active = counts.saved + counts.tailored + counts.applied + counts.interviewing;
    const sent = apps.filter((app) => isAppliedStatus(app.status));
    const interviews = counts.interviewing;
    const offers = counts.offer;
    const responses = counts.interviewing + counts.rejected + counts.offer;
    const responseRate = sent.length ? Math.round((responses / sent.length) * 100) : 0;
    const thisWeek = sent.filter((app) => app.appliedAt && Date.now() - app.appliedAt < 7 * 86_400_000).length;
    const awaiting = counts.saved + counts.tailored;

    const stats = [
      {
        label: "Active pipeline",
        value: active,
        sub: `${awaiting} awaiting a next step`,
        icon: "target",
        color: "#e8c77a",
        bg: "rgba(232, 199, 122,.07)",
        border: "rgba(232, 199, 122,.14)",
        glow: "rgba(232, 199, 122,.1)",
        up: false,
      },
      {
        label: "Applications sent",
        value: sent.length,
        sub: `${thisWeek} this week`,
        icon: "arrow-up-right",
        color: "#b4cb92",
        bg: "rgba(180, 203, 146,.07)",
        border: "rgba(180, 203, 146,.14)",
        glow: "rgba(180, 203, 146,.09)",
        up: thisWeek > 0,
      },
      {
        label: "Interviews",
        value: interviews,
        sub: `${responseRate}% response rate`,
        icon: "calendar",
        color: "#f0b45e",
        bg: "rgba(240, 180, 94,.07)",
        border: "rgba(240, 180, 94,.14)",
        glow: "rgba(240, 180, 94,.08)",
        up: interviews > 0,
      },
      {
        label: "Offers",
        value: offers,
        sub: offers ? "Strong signal — keep closing" : "Your next offer starts here",
        icon: "award",
        color: "#f7e1a8",
        bg: "rgba(247, 225, 168,.08)",
        border: "rgba(247, 225, 168,.16)",
        glow: "rgba(247, 225, 168,.1)",
        up: offers > 0,
      },
    ];

    statsWrap.innerHTML = stats.map((stat) => `
      <article class="stat-card" style="--stat-color:${stat.color};--stat-bg:${stat.bg};--stat-border:${stat.border};--stat-glow:${stat.glow}">
        <div class="stat-top">
          <span class="stat-label">${stat.label}</span>
          <span class="stat-icon">${icon(stat.icon)}</span>
        </div>
        <div class="stat-value">${stat.value}</div>
        <div class="stat-sub">${stat.up ? `<span class="up">${icon("trending-up")}</span>` : ""}${escapeHtml(stat.sub)}</div>
        <div class="stat-spark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </article>`).join("");

    board.innerHTML = STATUSES.map((status) => {
      const items = apps
        .filter((app) => app.status === status.id)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return `
        <section class="kanban-col" data-status="${status.id}" style="--col-color:${status.color};--col-glow:${status.color}55">
          <header class="col-head">
            <span class="col-dot"></span>
            <span class="col-title">${status.label}</span>
            <span class="col-count">${items.length}</span>
          </header>
          <div class="col-list">
            ${items.length ? items.map(appCardHtml).join("") : `<div class="col-empty">${emptyColumnCopy(status.id)}</div>`}
          </div>
        </section>`;
    }).join("");
  }

  function emptyColumnCopy(status) {
    const copy = {
      saved: "Saved roles land here.<br>Bookmark a job to start.",
      tailored: "Generate a tailored resume<br>to fill this stage.",
      applied: "Applications you send<br>will appear here.",
      interviewing: "Interview loops<br>in progress.",
      rejected: "Closed doors,<br>logged for learning.",
      offer: "The good news<br>lives here.",
    };
    return copy[status] || "Nothing here yet.";
  }

  function appCardHtml(app) {
    const job = allJobs().find((item) => item.id === app.jobId);
    if (!job) return "";
    const analysis = (app.tailored && app.tailored.analysis) || analyzeJob(job);
    const notes = (app.notes || "").trim();
    return `
      <article class="app-card" draggable="true" data-job-id="${escapeHtml(job.id)}">
        <div class="app-card-top">
          <span class="app-logo" style="${logoStyle(job)}" aria-hidden="true">${escapeHtml(job.logo)}</span>
          <div style="min-width:0">
            <div class="app-role">${escapeHtml(job.title)}</div>
            <div class="app-company">${escapeHtml(job.company)}</div>
          </div>
          ${icon("grip", "app-grip")}
        </div>
        <div class="app-card-meta">
          <span class="match-mini">${analysis.score}% match</span>
          ${app.tailored ? `<span class="app-resume-ready">${icon("sparkles")}Resume</span>` : ""}
          <span class="date-mini">${timeAgo(app.updatedAt)}</span>
        </div>
        ${notes ? `<p class="app-notes-preview">${escapeHtml(notes)}</p>` : ""}
        <div class="app-card-foot">
          <button class="mini-action" type="button" data-action="open-track" data-job-id="${escapeHtml(job.id)}">${icon("notes")}Notes</button>
          <button class="mini-action open" type="button" data-action="open-posting" data-job-id="${escapeHtml(job.id)}">${icon("external-link")}Open</button>
        </div>
      </article>`;
  }

  function rankBullets(bullets, analysis, limit) {
    return (bullets || [])
      .map((bullet, index) => {
        const lower = bullet.toLowerCase();
        const score = analysis.required.reduce(
          (total, entry) => total + entry.terms.reduce((sum, term) => sum + (termMatches(lower, term) ? 1 : 0), 0),
          0
        );
        return { bullet, index, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map((item) => item.bullet);
  }

  function prioritizedSkills(job, analysis) {
    const resume = state.resume;
    const resumeLower = resumeText().toLowerCase();
    const priority = (job.skills || []).filter(
      (skill) => resumeLower.includes(skill.toLowerCase()) || analysis.matched.some((item) => item.label === skill)
    );
    const rest = (resume.skills || []).filter((skill) => !priority.some((item) => item.toLowerCase() === skill.toLowerCase()));
    return Array.from(new Set([...priority, ...rest])).slice(0, 26);
  }

  function simulateTailoredResume(job, analysis) {
    const master = state.resume;
    const strengths = analysis.matched.slice(0, 5).map((item) => item.label);
    let summary = String(master.summary || "").replace(/\s+/g, " ").trim();
    if (strengths.length) {
      summary = `${summary.replace(/\.$/, "")}. Core strengths for this ${job.title} mandate: ${list(strengths)}.`;
    }

    return {
      name: master.name,
      title: master.title,
      email: master.email,
      phone: master.phone,
      location: master.location,
      website: master.website,
      summary,
      skills: prioritizedSkills(job, analysis),
      experience: (master.experience || []).map((role, index) => ({
        ...role,
        bullets: rankBullets(role.bullets, analysis, index === 0 ? 4 : 3),
      })),
      education: clone(master.education || []),
      certifications: clone(master.certifications || []),
    };
  }

  function numericTokens(text) {
    return String(text).match(/\d+(?:\.\d+)?%?/g) || [];
  }

  function containsNewNumbers(text, allowedNumbers) {
    return numericTokens(text).some((token) => !allowedNumbers.has(token));
  }

  function buildPrompt(job, analysis) {
    return `TARGET ROLE
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Job description: ${job.description}
Job skills: ${(job.skills || []).join(", ")}
Matched keywords (already evidenced in the resume): ${analysis.matched.map((item) => item.label).join(", ") || "none"}
Missing keywords (NOT evidenced — do not claim them): ${analysis.missing.map((item) => item.label).join(", ") || "none"}

MASTER RESUME (JSON)
${JSON.stringify(state.resume, null, 2)}

Return a tailored resume as JSON only, using exactly this shape:
{
  "summary": "rewritten professional summary",
  "skills": ["skills in priority order"],
  "experience": [
    { "company": "existing company name", "bullets": ["rephrased or prioritised existing bullets"] }
  ]
}

HARD RULES:
- Never invent employers, titles, dates, degrees, certifications, tools, metrics or outcomes.
- Do not add a skill unless it is already evidenced in the master resume.
- Preserve every number and metric exactly as written.
- You may rephrase, reorder and trim existing bullets to emphasise relevance to the target role.
- Keep the candidate's real job titles and companies unchanged.
- Output valid JSON with no markdown fences and no commentary.`;
  }

  const SYSTEM_PROMPT =
    "You are a meticulous resume editor. You optimise existing facts for a target job without inventing anything. " +
    "You return strictly valid JSON. You never add skills, tools, employers, dates, metrics or achievements that are not present in the source resume.";

  function parseJsonResponse(raw) {
    const text = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("The model did not return JSON.");
    return JSON.parse(text.slice(start, end + 1));
  }

  async function generateWithAI(job, analysis, provider, key, model) {
    const prompt = buildPrompt(job, analysis);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let raw = "";

    try {
      if (provider === "openai") {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            temperature: 0.35,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`OpenAI returned ${response.status}. ${detail.slice(0, 160)}`);
        }
        const data = await response.json();
        raw = data.choices?.[0]?.message?.content || "";
      } else if (provider === "anthropic") {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model,
            max_tokens: 3000,
            temperature: 0.35,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`Anthropic returned ${response.status}. ${detail.slice(0, 160)}`);
        }
        const data = await response.json();
        raw = (data.content || []).map((part) => part.text || "").join("\n");
      } else if (provider === "freellmapi") {
        const baseUrl = String(state.ai.baseUrl || FREELLMAPI_DEFAULT_URL).replace(/\/+$/, "");
        let response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              temperature: 0.35,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
              ],
            }),
          });
        } catch (error) {
          if (error.name === "AbortError") throw error;
          throw new Error(`Could not reach FreeLLMAPI at ${baseUrl}. Check that it is running and that DASHBOARD_ORIGINS includes ${location.origin}.`);
        }
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`FreeLLMAPI returned ${response.status}. ${detail.slice(0, 160)}`);
        }
        const data = await response.json();
        raw = data.choices?.[0]?.message?.content || "";
      } else {
        throw new Error("Unknown AI provider.");
      }
    } finally {
      clearTimeout(timeout);
    }

    return mergeAIResume(parseJsonResponse(raw), job, analysis);
  }

  function mergeAIResume(data, job, analysis) {
    const master = state.resume;
    const fallback = simulateTailoredResume(job, analysis);
    const allowedNumbers = new Set(numericTokens(resumeText()));
    const resumeLower = resumeText().toLowerCase();

    let summary = fallback.summary;
    if (typeof data.summary === "string" && data.summary.trim().length > 40 && !containsNewNumbers(data.summary, allowedNumbers)) {
      summary = data.summary.trim();
    }

    const allowedSkill = (skill) =>
      (master.skills || []).some((item) => item.toLowerCase() === String(skill).toLowerCase()) ||
      resumeLower.includes(String(skill).toLowerCase());
    const modelSkills = Array.isArray(data.skills)
      ? data.skills.map((skill) => String(skill).trim()).filter((skill) => skill.length > 1 && allowedSkill(skill))
      : [];
    const skills = Array.from(new Set([...modelSkills, ...fallback.skills]));

    const modelRoles = Array.isArray(data.experience) ? data.experience : [];
    const experience = (master.experience || []).map((role, index) => {
      const match = modelRoles.find(
        (item) => item && String(item.company || "").trim().toLowerCase() === String(role.company || "").toLowerCase()
      ) || modelRoles[index];
      const rawBullets = match && Array.isArray(match.bullets) ? match.bullets : [];
      const safeBullets = rawBullets
        .map((bullet) => String(bullet).replace(/\s+/g, " ").trim())
        .filter((bullet) => bullet.length > 15 && !containsNewNumbers(bullet, allowedNumbers))
        .slice(0, 6);
      return {
        ...role,
        bullets: safeBullets.length ? safeBullets : fallback.experience[index]?.bullets || role.bullets,
      };
    });

    return {
      ...clone(master),
      summary,
      skills,
      experience,
    };
  }

  function openTailor(jobId, options = {}) {
    const job = allJobs().find((item) => item.id === jobId);
    if (!job) {
      showToast("Role not found", "That job is no longer in your feed.", "error");
      return;
    }
    if (!(state.resume.experience || []).length && !(state.resume.summary || "").trim()) {
      showToast("Add your resume first", "Upload or edit your master resume in Settings, then tailor.", "error");
      setView("settings");
      return;
    }
    if (!$("#trackModal").hidden) closeModal("track");
    const app = getApp(jobId);
    const analysis = (app && app.tailored && app.tailored.analysis) || analyzeJob(job);
    currentTailor = { job, analysis, snapshot: (app && app.tailored) || null };
    openModal("tailor");
    const title = $("#tailorTitle");
    if (title) title.textContent = `Tailoring for ${job.company}`;
    renderTailorSide(job, analysis);

    if (app && app.tailored && !options.regenerate) {
      currentTailor.analysis = app.tailored.analysis || analysis;
      currentTailor.snapshot = app.tailored;
      showResult(app.tailored);
      return;
    }

    startGeneration(job, analysis);
  }

  function renderTailorSide(job, analysis) {
    const side = $("#tailorSide");
    if (!side) return;
    const app = getApp(job.id);
    const matched = analysis.matched.slice(0, 9);
    const missing = analysis.missing.slice(0, 7);
    const status = app ? STATUS_MAP[app.status] : null;

    side.innerHTML = `
      <div class="side-company">
        <div class="company-logo" style="${logoStyle(job)}" aria-hidden="true">${escapeHtml(job.logo)}</div>
        <div>
          <h3>${escapeHtml(job.title)}</h3>
          <p>${escapeHtml(job.company)} · ${escapeHtml(job.location)}</p>
        </div>
      </div>

      <div class="side-meta">
        <div class="side-meta-row">${icon("briefcase")}<span>${escapeHtml(job.type)} · ${escapeHtml(job.mode)}</span></div>
        <div class="side-meta-row">${icon("layers")}<span>${escapeHtml(job.experience)} level</span></div>
        <div class="side-meta-row">${icon("zap")}<span>${escapeHtml(job.salary)}</span></div>
        <div class="side-meta-row">${icon("clock")}<span>Posted ${postedLabel(job.postedHours)} · ${escapeHtml(job.source)}</span></div>
        ${status ? `<div class="side-meta-row">${icon("target")}<span>Pipeline stage: ${status.label}</span></div>` : ""}
      </div>

      <div class="side-match">
        <div class="side-match-top">
          <span class="side-match-label">Resume match</span>
          <span class="side-match-score">${analysis.score}<small>%</small></span>
        </div>
        <div class="side-match-bar"><span style="width:${analysis.score}%"></span></div>
      </div>

      <div class="side-section">
        <h4>Matched keywords <span>${matched.length}</span></h4>
        <div class="keyword-list">
          ${matched.length ? matched.map((item) => `<span class="keyword-chip matched">${escapeHtml(item.label)}</span>`).join("") : `<span class="keyword-chip">No strong overlaps found</span>`}
        </div>
      </div>

      <div class="side-section">
        <h4>Gaps not added <span>${missing.length}</span></h4>
        <div class="keyword-list">
          ${missing.length ? missing.map((item) => `<span class="keyword-chip missing">${escapeHtml(item.label)}</span>`).join("") : `<span class="keyword-chip matched">No material gaps</span>`}
        </div>
      </div>

      <div class="side-section side-jd" id="sideJd">
        <h4>Job description</h4>
        <p>${escapeHtml(job.description)}</p>
        <button class="jd-toggle" type="button" data-action="toggle-jd">Read full JD ↗</button>
      </div>

      <div class="side-source">${icon("external-link")}Source: ${escapeHtml(job.source)} · redirect only</div>`;
  }

  const GEN_STEPS = [
    {
      label: "Parse the job description",
      title: "Reading the job description",
      sub: "Extracting requirements, tools and domain language from the JD.",
    },
    {
      label: "Map against your resume",
      title: "Mapping your experience",
      sub: "Checking every requirement against your real experience — no guesswork.",
    },
    {
      label: "Rewrite & prioritise",
      title: "Sharpening the narrative",
      sub: "Rewriting the summary and prioritising your strongest, most relevant bullets.",
    },
    {
      label: "Format the document",
      title: "Formatting the document",
      sub: "Light reorder, keyword emphasis and an ATS-friendly structure.",
    },
  ];

  function setGenerationStep(step, analysis) {
    const progress = [18, 46, 74, 100][Math.min(step, 3)];
    const stepData = GEN_STEPS[Math.min(step, 3)];
    const done = step >= 4;
    const title = $("#genTitle");
    const subtitle = $("#genSubtitle");
    const label = $("#genProgressLabel");
    const pct = $("#genProgressPct");
    const bar = $("#genProgressBar");
    const steps = $("#genSteps");

    if (title) title.textContent = done ? "Your tailored resume is ready" : stepData.title;
    if (subtitle) {
      if (done) {
        subtitle.textContent = "Review the changes, then open the original application. Nothing is submitted for you.";
      } else if (step === 1 && analysis) {
        subtitle.textContent = `${analysis.matched.length} of ${analysis.required.length} requirements already have evidence in your resume. Gaps will be disclosed, not invented.`;
      } else {
        subtitle.textContent = stepData.sub;
      }
    }
    if (label) label.textContent = done ? "Complete" : `Step ${Math.min(step + 1, 4)} of 4`;
    if (pct) pct.textContent = done ? "100%" : `${progress}%`;
    if (bar) bar.style.width = done ? "100%" : `${progress}%`;

    if (steps) {
      steps.innerHTML = GEN_STEPS.map((item, index) => {
        const cls = index < step || done ? "done" : index === step ? "active" : "";
        return `<div class="gen-step ${cls}">
          <span class="gen-step-icon">${icon("check")}</span>
          <span>${escapeHtml(item.label)}</span>
        </div>`;
      }).join("");
    }
  }

  async function startGeneration(job, analysis) {
    const token = ++generationToken;
    const generation = $("#generationPane");
    const result = $("#resultPane");
    if (!generation || !result) return;
    generation.hidden = false;
    result.hidden = true;

    let provider = state.ai.provider || "demo";
    let key = (state.ai.keys || {})[provider] || "";
    let engine = provider;
    if (provider !== "demo" && !key) {
      showToast("API key missing", "Add your key in Settings → AI engine. Using the on-device fallback for this run.", "error");
      engine = "demo";
    }
    if (engine === "demo") {
      provider = "demo";
      key = "";
    }
    const model = state.ai.model || ENGINE_DEFAULTS[provider];
    if ($("#genEngineLabel")) $("#genEngineLabel").textContent = ENGINE_LABELS[engine] || ENGINE_LABELS.demo;
    if ($("#tailorFooterActions")) $("#tailorFooterActions").innerHTML = "";
    if ($("#tailorFooterHint")) {
      $("#tailorFooterHint").innerHTML = `${icon("shield")}Nothing is submitted automatically.`;
    }

    setGenerationStep(0, analysis);
    await sleep(620);
    if (token !== generationToken) return;

    setGenerationStep(1, analysis);
    await sleep(680);
    if (token !== generationToken) return;

    setGenerationStep(2, analysis);
    let generated;
    if (provider === "demo") {
      await sleep(980);
      if (token !== generationToken) return;
      generated = simulateTailoredResume(job, analysis);
    } else {
      if ($("#genSubtitle")) {
        $("#genSubtitle").textContent = `Contacting ${ENGINE_LABELS[provider].split(" ")[0]} and applying the no-fabrication guard…`;
      }
      try {
        generated = await generateWithAI(job, analysis, provider, key, model);
      } catch (error) {
        console.error("AutoMatch AI generation failed:", error);
        showToast("AI request failed", `${error.message || "The request failed."} Falling back to the local engine.`, "error");
        engine = "demo";
        generated = simulateTailoredResume(job, analysis);
        if ($("#genEngineLabel")) $("#genEngineLabel").textContent = ENGINE_LABELS.demo;
      }
      if (token !== generationToken) return;
    }

    setGenerationStep(3, analysis);
    await sleep(520);
    if (token !== generationToken) return;

    const app = ensureApp(job.id);
    if (!isAppliedStatus(app.status)) app.status = "tailored";
    touchApp(app);
    app.tailored = {
      resume: generated,
      analysis,
      generatedAt: Date.now(),
      engine,
      master: clone(state.resume),
    };
    saveState();
    currentTailor = { ...currentTailor, analysis, snapshot: app.tailored };
    renderJobs();
    renderDashboard();
    updateChrome();

    setGenerationStep(4, analysis);
    await sleep(430);
    if (token !== generationToken) return;
    showResult(app.tailored);
    showToast("Tailored resume ready", `${job.company} · ${analysis.score}% keyword alignment. Review before applying.`);
  }

  function showResult(snapshot) {
    if (!snapshot) return;
    const generation = $("#generationPane");
    const result = $("#resultPane");
    if (generation) generation.hidden = true;
    if (result) result.hidden = false;
    if ($("#tailorTitle")) $("#tailorTitle").textContent = `Tailored for ${currentTailor.job.company}`;
    const app = getApp(currentTailor.job.id);
    if (app && app.tailored) currentTailor.snapshot = app.tailored;
    renderTailorSide(currentTailor.job, snapshot.analysis || currentTailor.analysis);
    renderTailoredResult(currentTailor.job, snapshot);
    renderTailorFooter(currentTailor.job, snapshot);
    switchTab("resume");
    const main = $(".tailor-main");
    if (main) main.scrollTop = 0;
  }

  function renderTailoredResult(job, snapshot) {
    const analysis = snapshot.analysis || currentTailor.analysis;
    const resume = snapshot.resume;
    if ($("#resumePaper")) $("#resumePaper").innerHTML = paperHtml(resume, analysis);
    if ($("#diffContent")) $("#diffContent").innerHTML = diffHtml(snapshot);
    const count = countChanges(snapshot);
    if ($("#diffCount")) $("#diffCount").textContent = count;
    if ($("#analysisContent")) $("#analysisContent").innerHTML = analysisHtml(job, analysis);
  }

  function paperHtml(resume, analysis) {
    const labels = (analysis.matched || []).map((item) => item.label);
    const matchedLabels = new Set(labels);
    const contact = [resume.email, resume.phone, resume.location, resume.website].filter(Boolean);
    return `
      <header class="paper-header">
        <div class="paper-name">${escapeHtml(resume.name)}</div>
        <div class="paper-role">${escapeHtml(resume.title)}</div>
        <div class="paper-contact">${contact.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      </header>

      <section class="paper-section">
        <div class="paper-section-title">Professional Summary</div>
        <p class="paper-summary">${emphasize(resume.summary, labels)}</p>
      </section>

      <section class="paper-section">
        <div class="paper-section-title">Core Competencies</div>
        <div class="paper-skills">
          ${(resume.skills || []).map((skill) => `<span class="paper-skill ${matchedLabels.has(skill) ? "emphasis" : ""}">${escapeHtml(skill)}</span>`).join("")}
        </div>
      </section>

      <section class="paper-section">
        <div class="paper-section-title">Experience</div>
        ${(resume.experience || []).map((role) => `
          <div class="paper-role-item">
            <div class="paper-role-head">
              <strong>${escapeHtml(role.title || "Role")}</strong>
              <span>${escapeHtml(role.dates || "")}</span>
            </div>
            <div class="paper-role-sub">
              <span>${escapeHtml(role.company || "")}${role.location ? ` · ${escapeHtml(role.location)}` : ""}</span>
            </div>
            <ul class="paper-bullets">
              ${(role.bullets || []).map((bullet) => `<li>${emphasize(bullet, labels)}</li>`).join("")}
            </ul>
          </div>`).join("")}
      </section>

      ${(resume.education || []).length ? `
        <section class="paper-section">
          <div class="paper-section-title">Education</div>
          ${(resume.education || []).map((edu) => `
            <div class="paper-edu">
              <div><strong>${escapeHtml(edu.school || "")}</strong><p>${escapeHtml(edu.degree || "")}</p></div>
              <span>${escapeHtml(edu.dates || "")}</span>
            </div>`).join("")}
        </section>` : ""}

      ${(resume.certifications || []).length ? `
        <section class="paper-section">
          <div class="paper-section-title">Certifications</div>
          <div class="paper-skills">
            ${(resume.certifications || []).map((cert) => `<span class="paper-skill">${escapeHtml(cert)}</span>`).join("")}
          </div>
        </section>` : ""}`;
  }

  function resumePlainText(resume) {
    const lines = [];
    lines.push(resume.name || "");
    lines.push(resume.title || "");
    lines.push([resume.email, resume.phone, resume.location, resume.website].filter(Boolean).join(" | "));
    lines.push("");
    lines.push("PROFESSIONAL SUMMARY");
    lines.push(resume.summary || "");
    lines.push("");
    lines.push("CORE COMPETENCIES");
    lines.push((resume.skills || []).join(", "));
    lines.push("");
    lines.push("EXPERIENCE");
    (resume.experience || []).forEach((role) => {
      lines.push(`${role.title || ""} — ${role.company || ""} | ${role.dates || ""}${role.location ? ` | ${role.location}` : ""}`);
      (role.bullets || []).forEach((bullet) => lines.push(`• ${bullet}`));
      lines.push("");
    });
    if ((resume.education || []).length) {
      lines.push("EDUCATION");
      (resume.education || []).forEach((edu) => lines.push(`${edu.school || ""} — ${edu.degree || ""} | ${edu.dates || ""}`));
      lines.push("");
    }
    if ((resume.certifications || []).length) {
      lines.push("CERTIFICATIONS");
      (resume.certifications || []).forEach((cert) => lines.push(`• ${cert}`));
    }
    return lines.join("\n");
  }

  function renderTailorFooter(job, snapshot) {
    const app = getApp(job.id);
    const applied = Boolean(app && isAppliedStatus(app.status));
    const hint = $("#tailorFooterHint");
    const actions = $("#tailorFooterActions");
    if (hint) {
      hint.innerHTML = applied
        ? `${icon("check-circle")}${STATUS_MAP[app.status].label} · tracked on your board${app.appliedAt ? ` since ${formatDate(app.appliedAt)}` : ""}.`
        : `${icon("shield")}Nothing is submitted automatically. We open the original posting.`;
    }
    if (actions) {
      actions.innerHTML = applied
        ? `<button class="btn btn-ghost btn-sm" type="button" data-action="view-board" data-job-id="${escapeHtml(job.id)}">${icon("dashboard")}View board</button>
           <button class="btn btn-success" type="button" data-action="apply-now" data-job-id="${escapeHtml(job.id)}">${icon("external-link")}Open posting</button>`
        : `<button class="btn btn-ghost btn-sm" type="button" data-action="regenerate" data-job-id="${escapeHtml(job.id)}">${icon("refresh")}Regenerate</button>
           <button class="btn btn-ghost btn-sm" type="button" data-action="view-board" data-job-id="${escapeHtml(job.id)}">${icon("dashboard")}View board</button>
           <button class="btn btn-success" type="button" data-action="apply-now" data-job-id="${escapeHtml(job.id)}">${icon("external-link")}Open application</button>`;
    }
  }

  function switchTab(name) {
    $$(".tab[data-tab]", $("#tailorModal")).forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    ["resume", "diff", "analysis"].forEach((key) => {
      const pane = $(`#tab-${key}`);
      if (pane) pane.classList.toggle("active", key === name);
    });
  }

  function wordDiff(oldText, newText) {
    const a = String(oldText || "").match(/\S+\s*/g) || [];
    const b = String(newText || "").match(/\S+\s*/g) || [];
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i += 1) {
      for (let j = 1; j <= n; j += 1) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    let i = m;
    let j = n;
    const ops = [];
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        ops.unshift({ type: "same", text: a[i - 1] });
        i -= 1;
        j -= 1;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        ops.unshift({ type: "del", text: a[i - 1] });
        i -= 1;
      } else {
        ops.unshift({ type: "add", text: b[j - 1] });
        j -= 1;
      }
    }
    while (i > 0) { ops.unshift({ type: "del", text: a[i - 1] }); i -= 1; }
    while (j > 0) { ops.unshift({ type: "add", text: b[j - 1] }); j -= 1; }

    let oldHtml = "";
    let newHtml = "";
    let added = 0;
    let removed = 0;
    ops.forEach((op) => {
      if (op.type === "same") {
        oldHtml += escapeHtml(op.text);
        newHtml += escapeHtml(op.text);
      } else if (op.type === "del") {
        oldHtml += `<del>${escapeHtml(op.text)}</del>`;
        removed += 1;
      } else {
        newHtml += `<ins>${escapeHtml(op.text)}</ins>`;
        added += 1;
      }
    });
    return { oldHtml, newHtml, added, removed };
  }

  function countChanges(snapshot) {
    if (!snapshot || !snapshot.resume) return 0;
    const master = snapshot.master || state.resume;
    const tailored = snapshot.resume;
    let count = 0;
    const summaryDiff = wordDiff(master.summary, tailored.summary);
    if (summaryDiff.added || summaryDiff.removed) count += 1;
    if (JSON.stringify(master.skills || []) !== JSON.stringify(tailored.skills || [])) count += 1;

    (tailored.experience || []).forEach((role, index) => {
      const original = (master.experience || [])[index] || { bullets: [] };
      const orig = original.bullets || [];
      const next = role.bullets || [];
      if (orig.length !== next.length) count += Math.abs(orig.length - next.length);
      next.forEach((bullet, bulletIndex) => {
        if (orig[bulletIndex] !== bullet) count += 1;
      });
    });
    return count;
  }

  function diffHtml(snapshot) {
    if (!snapshot || !snapshot.resume) return `<div class="diff-empty">No tailored version yet.</div>`;
    const master = snapshot.master || state.resume;
    const tailored = snapshot.resume;
    const analysis = snapshot.analysis || currentTailor.analysis;
    const labels = (analysis.matched || []).map((item) => item.label);
    const summaryDiff = wordDiff(master.summary, tailored.summary);
    const matched = new Set(labels);

    const experienceBlocks = (tailored.experience || []).map((role, roleIndex) => {
      const originalRole = (master.experience || [])[roleIndex] || { bullets: [] };
      const originalBullets = originalRole.bullets || [];
      const trimmed = Math.max(0, originalBullets.length - (role.bullets || []).length);
      return `
        <div class="diff-block">
          <div class="diff-block-head">
            <span>${escapeHtml(role.title)} · ${escapeHtml(role.company)}</span>
            <span>${trimmed ? `${trimmed} least relevant bullet${trimmed === 1 ? "" : "s"} trimmed` : "All bullets retained"}</span>
          </div>
          <div class="diff-list">
            ${(role.bullets || []).map((bullet, index) => {
              const originalIndex = originalBullets.indexOf(bullet);
              const reordered = originalIndex !== -1 && originalIndex !== index;
              return `<div class="diff-line ${reordered ? "reordered" : ""}">
                <span class="marker">${reordered ? "↕" : "•"}</span>
                <div>${emphasize(bullet, labels)}</div>
              </div>`;
            }).join("") || `<div class="diff-line"><span class="marker">—</span><div>No bullets in this role.</div></div>`}
          </div>
        </div>`;
    }).join("");

    return `
      <div class="diff-summary">
        ${icon("check-circle")}
        <div><strong>${countChanges(snapshot)} changes</strong> · your facts are intact. The summary was reframed, relevant bullets were prioritised, and keyword emphasis was applied.</div>
      </div>
      <div class="diff-legend">
        <span><i class="legend-swatch add"></i>Added / reframed</span>
        <span><i class="legend-swatch del"></i>Removed from summary</span>
        <span style="color:var(--violet)">↕ Reordered</span>
      </div>

      <div class="diff-block">
        <div class="diff-block-head"><span>Professional summary</span><span>${summaryDiff.added + summaryDiff.removed} word changes</span></div>
        <div class="diff-cols">
          <div class="diff-col"><span class="diff-col-label">Master</span>${summaryDiff.oldHtml}</div>
          <div class="diff-col"><span class="diff-col-label">Tailored</span>${summaryDiff.newHtml}</div>
        </div>
      </div>

      <div class="diff-block">
        <div class="diff-block-head"><span>Core competencies</span><span>Reordered for this JD</span></div>
        <div class="diff-cols">
          <div class="diff-col"><span class="diff-col-label">Master</span><div class="analysis-chips">${(master.skills || []).map((skill) => `<span class="keyword-chip">${escapeHtml(skill)}</span>`).join("")}</div></div>
          <div class="diff-col"><span class="diff-col-label">Tailored</span><div class="analysis-chips">${(tailored.skills || []).map((skill) => `<span class="keyword-chip ${matched.has(skill) ? "matched" : ""}">${escapeHtml(skill)}</span>`).join("")}</div></div>
        </div>
      </div>

      ${experienceBlocks}

      <p class="diff-note">AutoMatch does not add employers, tools, metrics or achievements. Every AI-generated bullet passes a numeric guard before it reaches this view, and the on-device fallback only reorders, trims and reframes existing content.</p>`;
  }

  function analysisHtml(job, analysis) {
    const gapText = analysis.missing.length
      ? `${analysis.missing.map((item) => item.label).join(", ")}. If you genuinely have this experience, add it to your master resume first — do not let an AI invent it.`
      : "Every requirement detected in this JD has some evidence in your master resume. Review the wording before applying.";
    return `
      <div class="analysis-hero">
        <div class="analysis-score-ring" style="--score:${analysis.score}"><span>${analysis.score}%</span></div>
        <div class="analysis-hero-copy">
          <h3>${analysis.matched.length} of ${analysis.required.length} requirements have evidence</h3>
          <p>This is a keyword and evidence check, not a guarantee. Use it to decide what to emphasise in the application — and what to address honestly in an interview.</p>
        </div>
      </div>

      <div class="analysis-grid">
        <div class="analysis-card">
          <h4>Matched in your resume <span>${analysis.matched.length}</span></h4>
          <div class="analysis-chips">
            ${analysis.matched.map((item) => `<span class="keyword-chip matched">${escapeHtml(item.label)}</span>`).join("") || `<span class="keyword-chip">None detected</span>`}
          </div>
        </div>
        <div class="analysis-card">
          <h4>Not evidenced <span>${analysis.missing.length}</span></h4>
          <div class="analysis-chips">
            ${analysis.missing.map((item) => `<span class="keyword-chip missing">${escapeHtml(item.label)}</span>`).join("") || `<span class="keyword-chip matched">No material gaps</span>`}
          </div>
        </div>
        <div class="gap-note">
          ${icon("alert")}
          <div><strong>No fabrication rule</strong><p>${escapeHtml(gapText)}</p></div>
        </div>
        <div class="analysis-card" style="grid-column:1/-1">
          <h4>Detected JD requirements <span>${analysis.required.length}</span></h4>
          <div class="analysis-chips">
            ${analysis.required.map((item) => `<span class="keyword-chip ${matchedSet(analysis).has(item.label) ? "matched" : "missing"}">${escapeHtml(item.label)}</span>`).join("")}
          </div>
        </div>
      </div>

      <div class="jd-full">
        <h4>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</h4>
        <p>${escapeHtml(job.description)}</p>
      </div>`;
  }

  function matchedSet(analysis) {
    return new Set((analysis.matched || []).map((item) => item.label));
  }

  function showToast(title, message = "", type = "success") {
    const stack = $("#toastStack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const iconName = type === "error" ? "alert" : type === "info" ? "info" : "check-circle";
    toast.innerHTML = `
      <span class="toast-icon">${icon(iconName)}</span>
      <div class="toast-copy"><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div>
      <button class="toast-close" type="button" aria-label="Dismiss">${icon("x")}</button>`;
    stack.appendChild(toast);
    const remove = () => {
      toast.classList.add("out");
      setTimeout(() => toast.remove(), 260);
    };
    toast.querySelector(".toast-close").addEventListener("click", remove);
    setTimeout(remove, 5200);
    while (stack.children.length > 4) stack.firstElementChild.remove();
  }

  function openModal(name) {
    const modal = document.getElementById(`${name}Modal`);
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closeModal(name) {
    const modal = document.getElementById(`${name}Modal`);
    if (!modal) return;
    if (name === "track") persistTrackDraft();
    if (name === "tailor") generationToken += 1;
    modal.hidden = true;
    if (name === "track") currentTrackJobId = null;
    const anyOpen = $$(".modal-layer").some((layer) => !layer.hidden);
    if (!anyOpen) document.body.classList.remove("modal-open");
  }

  function closeAllModals() {
    $$(".modal-layer").forEach((layer) => { layer.hidden = true; });
    document.body.classList.remove("modal-open");
    generationToken += 1;
    currentTrackJobId = null;
  }

  function persistTrackDraft() {
    if (!currentTrackJobId) return;
    const app = getApp(currentTrackJobId);
    if (!app) return;
    const notes = $("#trackNotes");
    const attachment = $("#trackAttachment");
    let changed = false;
    if (notes && notes.value !== app.notes) {
      app.notes = notes.value;
      changed = true;
    }
    if (attachment && attachment.value !== app.attachment) {
      app.attachment = attachment.value.trim();
      changed = true;
    }
    if (changed) {
      touchApp(app);
      saveState();
    }
  }

  function applyToJob(jobId) {
    const job = allJobs().find((item) => item.id === jobId);
    if (!job) return;
    window.open(job.url, "_blank", "noopener,noreferrer");
    const app = ensureApp(jobId);
    if (!isAppliedStatus(app.status)) {
      app.status = "applied";
      app.appliedAt = Date.now();
    }
    touchApp(app);
    saveState();
    renderJobs();
    renderDashboard();
    updateChrome();
    if (currentTailor && currentTailor.job.id === jobId && !$("#tailorModal").hidden) {
      renderTailorSide(job, currentTailor.analysis);
      renderTailorFooter(job, currentTailor.snapshot);
    }
    if (currentTrackJobId === jobId && !$("#trackModal").hidden) renderTrack(jobId);
    showToast(
      "Application tracked",
      `Opened the original ${job.company} posting. Card moved to Applied — add notes when you're back.`
    );
  }

  function safeFilename(value) {
    return String(value || "resume").replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 70);
  }

  async function copyTailoredResume() {
    if (!currentTailor || !currentTailor.snapshot) return;
    const text = resumePlainText(currentTailor.snapshot.resume);
    try {
      await navigator.clipboard.writeText(text);
      showToast("Resume copied", "Plain text is on your clipboard, ready for an application form.");
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      showToast("Resume copied", "Plain text is on your clipboard.");
    }
  }

  function documentStyles() {
    return `
      @page { size: A4; margin: 13mm 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #fff; color: #221d17; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.5; }
      .paper { width: 100%; max-width: 100%; background: #fff; color: #221d17; padding: 0; }
      .paper-header { text-align: center; padding-bottom: 12px; border-bottom: 1.5px solid #2a241c; }
      .paper-name { font-family: Arial, Helvetica, sans-serif; font-size: 25pt; font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; }
      .paper-role { font-size: 10.5pt; color: #5c5348; letter-spacing: 0.04em; margin-top: 3px; }
      .paper-contact { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 7px; font-size: 8.5pt; color: #544b3f; }
      .paper-section { margin-top: 14px; }
      .paper-section-title { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #16120c; padding-bottom: 3px; border-bottom: 1px solid #cdc4b4; margin-bottom: 7px; }
      .paper-summary { color: #3a332a; }
      .paper-skills { display: flex; flex-wrap: wrap; gap: 4px 6px; }
      .paper-skill { font-size: 8.5pt; padding: 1px 5px; border-radius: 3px; background: #f2eee5; color: #443c31; border: 1px solid #e4ded1; }
      .paper-skill.emphasis { background: #f2eee5; color: #443c31; border-color: #e4ded1; }
      .paper-role-item { margin-bottom: 10px; page-break-inside: avoid; }
      .paper-role-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
      .paper-role-head strong { font-size: 10.5pt; font-weight: 700; color: #17130e; }
      .paper-role-head span { font-size: 8pt; color: #726a5c; white-space: nowrap; }
      .paper-role-sub { display: flex; justify-content: space-between; gap: 12px; font-size: 9pt; color: #625a4e; margin-top: 1px; }
      .paper-bullets { margin: 4px 0 0; padding-left: 14px; }
      .paper-bullets li { margin-bottom: 2.5px; color: #3a332a; }
      .paper mark { background: transparent; color: inherit; padding: 0; }
      .paper-edu { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
      .paper-edu strong { font-size: 9.5pt; }
      .paper-edu span { font-size: 8pt; color: #726a5c; white-space: nowrap; }
      .paper-edu p { font-size: 9pt; color: #625a4e; margin: 1px 0 0; }
      .paper-footnote { display: none; }`;
  }

  function downloadPdf() {
    if (!currentTailor || !currentTailor.snapshot) return;
    const job = currentTailor.job;
    const snapshot = currentTailor.snapshot;
    const win = window.open("", "_blank");
    if (!win) {
      showToast("Popup blocked", "Allow popups for this page to open the print/PDF view.", "error");
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>${escapeHtml(snapshot.resume.name)} — ${escapeHtml(job.company)} resume</title>
      <style>${documentStyles()}</style></head>
      <body>${paperHtml(snapshot.resume, snapshot.analysis)}</body></html>`;
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 500);
    showToast("PDF view opened", "Choose “Save as PDF” in the print dialog.");
  }

  function downloadWord() {
    if (!currentTailor || !currentTailor.snapshot) return;
    const job = currentTailor.job;
    const snapshot = currentTailor.snapshot;
    const html = `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
      <head><meta charset="utf-8"><title>${escapeHtml(snapshot.resume.name)} — ${escapeHtml(job.company)}</title>
      <style>${documentStyles()}</style></head>
      <body>${paperHtml(snapshot.resume, snapshot.analysis)}</body></html>`;
    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(snapshot.resume.name)}_${safeFilename(job.company)}_resume.doc`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("Word document downloaded", "Opens in Word, Google Docs or Pages.");
  }

  function downloadJsonBackup() {
    const backup = {
      exportedAt: new Date().toISOString(),
      applications: state.applications,
      resume: state.resume,
      prefs: state.prefs,
      ai: { provider: state.ai.provider, model: state.ai.model },
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `automatch-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("Workspace exported", "Applications and resume saved as JSON. API keys are excluded.");
  }

  function openTrack(jobId) {
    const job = allJobs().find((item) => item.id === jobId);
    if (!job) return;
    if (getApp(jobId) == null) {
      ensureApp(jobId, "saved");
      saveState();
      renderJobs();
      renderDashboard();
      updateChrome();
    }
    currentTrackJobId = jobId;
    renderTrack(jobId);
    openModal("track");
  }

  function renderTrack(jobId) {
    const job = allJobs().find((item) => item.id === jobId);
    const app = getApp(jobId);
    if (!job || !app) return;
    const analysis = (app.tailored && app.tailored.analysis) || analyzeJob(job);
    const status = STATUS_MAP[app.status] || STATUS_MAP.saved;

    const head = $("#trackHead");
    if (head) {
      head.innerHTML = `
        <div class="company-logo" style="${logoStyle(job)}" aria-hidden="true">${escapeHtml(job.logo)}</div>
        <div class="track-title">
          <h2 id="trackTitle">${escapeHtml(job.title)}</h2>
          <p>${escapeHtml(job.company)} · ${escapeHtml(job.location)} <span class="keyword-chip" style="margin-left:4px">${status.label}</span></p>
        </div>`;
    }

    const timeline = [
      { label: "Saved to pipeline", ts: app.createdAt, done: true },
      { label: "Tailored resume generated", ts: app.tailored && app.tailored.generatedAt, done: Boolean(app.tailored) },
      { label: "Application sent", ts: app.appliedAt, done: Boolean(app.appliedAt) },
    ];
    if (["interviewing", "offer", "rejected"].includes(app.status)) {
      timeline.push({ label: `Moved to ${status.label}`, ts: app.updatedAt, done: true });
    }
    timeline.push({ label: "Last activity", ts: app.updatedAt, done: true });

    const body = $("#trackBody");
    if (body) {
      body.innerHTML = `
        <div class="track-main">
          <div class="track-section">
            <h3>Stage <span>Updates save immediately</span></h3>
            <div class="status-grid">
              ${STATUSES.map((item) => `<button class="status-btn ${item.id === app.status ? "active" : ""}" type="button" data-action="track-status" data-status="${item.id}" data-job-id="${escapeHtml(job.id)}"><i style="background:${item.color}"></i>${item.label}</button>`).join("")}
            </div>
          </div>

          <div class="track-section">
            <h3>Interview notes <span>${app.notes ? "Saved" : "Private to this browser"}</span></h3>
            <textarea class="track-textarea" id="trackNotes" placeholder="Recruiter names, interview themes, questions to ask, follow-up dates…">${escapeHtml(app.notes || "")}</textarea>
          </div>

          <div class="track-section">
            <h3>Attachment link <span>Portfolio, take-home, Google Doc</span></h3>
            <div class="attachment-row">
              <input class="text-input" id="trackAttachment" type="url" placeholder="https://…" value="${escapeHtml(app.attachment || "")}" />
              <button class="btn btn-ghost btn-sm" type="button" data-action="open-attachment">${icon("external-link")}Open</button>
            </div>
          </div>

          <div class="track-section">
            <h3>Quick facts</h3>
            <div class="track-side-card">
              <p>${escapeHtml(job.title)} at ${escapeHtml(job.company)} · ${escapeHtml(job.mode)} · ${escapeHtml(job.salary)}<br/>${escapeHtml(job.team)} team · posted ${postedLabel(job.postedHours)} via ${escapeHtml(job.source)}.</p>
            </div>
          </div>
        </div>

        <div class="track-side">
          <div class="track-section">
            <h3>Tailored resume</h3>
            ${app.tailored ? `
              <div class="track-side-card">
                <div class="track-resume">
                  <span class="track-resume-icon">${icon("sparkles")}</span>
                  <div><strong>${escapeHtml(job.company)} version</strong><small>Generated ${formatDate(app.tailored.generatedAt)}</small></div>
                </div>
                <div class="track-side-metric"><span>Keyword match</span><strong>${analysis.score}%</strong></div>
                <button class="btn btn-violet btn-sm btn-full" type="button" data-action="view-tailored" data-job-id="${escapeHtml(job.id)}" style="margin-top:10px">${icon("eye")}Open tailored resume</button>
              </div>` : `
              <div class="track-side-card">
                <h4>No tailored version yet</h4>
                <p>Generate a job-specific resume before you send this application.</p>
                <button class="btn btn-violet btn-sm btn-full" type="button" data-action="tailor-from-track" data-job-id="${escapeHtml(job.id)}" style="margin-top:10px">${icon("sparkles")}Tailor now</button>
              </div>`}
          </div>

          <div class="track-section">
            <h3>Timeline</h3>
            <div class="track-timeline">
              ${timeline.map((item) => `
                <div class="timeline-item">
                  <span class="timeline-dot ${item.done && item.ts ? "done" : ""}"></span>
                  <div><strong>${escapeHtml(item.label)}</strong><small>${item.ts ? formatDate(item.ts) : "Not yet"}</small></div>
                </div>`).join("")}
            </div>
          </div>

          <div class="track-section">
            <h3>Source</h3>
            <div class="track-side-card">
              <p>${escapeHtml(job.source)} · redirect only. AutoMatch does not submit forms on third-party sites.</p>
              <button class="btn btn-ghost btn-sm btn-full" type="button" data-action="open-posting" data-job-id="${escapeHtml(job.id)}" style="margin-top:9px">${icon("external-link")}Open original posting</button>
            </div>
          </div>
        </div>`;
    }

    const footer = $("#trackFooter");
    if (footer) {
      footer.innerHTML = `
        <button class="btn btn-danger btn-sm" type="button" data-action="remove-app" data-job-id="${escapeHtml(job.id)}">${icon("trash")}Remove</button>
        <div class="footer-actions">
          <button class="btn btn-ghost" type="button" data-action="save-track" data-job-id="${escapeHtml(job.id)}">${icon("save")}Save notes</button>
          <button class="btn btn-success" type="button" data-action="open-posting" data-job-id="${escapeHtml(job.id)}">${icon("external-link")}Open posting</button>
        </div>`;
    }
  }

  function saveTrackNotes(jobId) {
    const app = getApp(jobId);
    if (!app) return;
    const notes = $("#trackNotes");
    const attachment = $("#trackAttachment");
    if (notes) app.notes = notes.value;
    if (attachment) app.attachment = attachment.value.trim();
    touchApp(app);
    saveState();
    renderDashboard();
    updateChrome();
    renderTrack(jobId);
    showToast("Notes saved", "Everything stays in this browser.");
  }

  function removeApplication(jobId) {
    const job = allJobs().find((item) => item.id === jobId);
    if (!confirm(`Remove this application from your board?\n\n${job ? `${job.title} · ${job.company}` : "This card"} will be deleted, including its notes and tailored resume.`)) return;
    state.applications = state.applications.filter((app) => app.jobId !== jobId);
    saveState();
    currentTrackJobId = null;
    closeModal("track");
    renderJobs();
    renderDashboard();
    updateChrome();
    showToast("Application removed", "The role is back to an untracked state.");
  }

  function openAttachment() {
    const input = $("#trackAttachment");
    const app = currentTrackJobId ? getApp(currentTrackJobId) : null;
    const value = (input ? input.value : app && app.attachment || "").trim();
    if (!/^https?:\/\//i.test(value)) {
      showToast("Add a valid link", "Attachment links must start with http:// or https://.", "error");
      return;
    }
    window.open(value, "_blank", "noopener,noreferrer");
  }

  function experienceItemHtml(role = {}, index = 0) {
    return `
      <div class="exp-item" data-exp-item>
        <div class="exp-item-top">
          <strong>Role ${index + 1}</strong>
          <button class="icon-btn" type="button" data-action="remove-experience" aria-label="Remove role" style="width:26px;height:26px">${icon("trash")}</button>
        </div>
        <div class="exp-fields">
          <div><label class="field-label">Job title</label><input class="text-input" data-exp-field="title" value="${escapeHtml(role.title || "")}" placeholder="Senior Product Manager" /></div>
          <div><label class="field-label">Company</label><input class="text-input" data-exp-field="company" value="${escapeHtml(role.company || "")}" placeholder="Company" /></div>
          <div><label class="field-label">Dates</label><input class="text-input" data-exp-field="dates" value="${escapeHtml(role.dates || "")}" placeholder="2021 — Present" /></div>
          <div><label class="field-label">Location</label><input class="text-input" data-exp-field="location" value="${escapeHtml(role.location || "")}" placeholder="Mumbai" /></div>
        </div>
        <label class="field-label">Bullets — one per line</label>
        <textarea data-exp-field="bullets" spellcheck="false">${escapeHtml((role.bullets || []).join("\n"))}</textarea>
      </div>`;
  }

  function openResumeEditor() {
    const resume = state.resume;
    const body = $("#resumeFormBody");
    if (!body) return;
    body.innerHTML = `
      <div class="form-section">
        <div class="form-section-head"><h3>Identity</h3></div>
        <div class="form-grid">
          <div><label class="field-label">Full name</label><input class="text-input" data-resume-field="name" value="${escapeHtml(resume.name || "")}" /></div>
          <div><label class="field-label">Professional title</label><input class="text-input" data-resume-field="title" value="${escapeHtml(resume.title || "")}" /></div>
          <div><label class="field-label">Email</label><input class="text-input" data-resume-field="email" value="${escapeHtml(resume.email || "")}" /></div>
          <div><label class="field-label">Phone</label><input class="text-input" data-resume-field="phone" value="${escapeHtml(resume.phone || "")}" /></div>
          <div><label class="field-label">Location</label><input class="text-input" data-resume-field="location" value="${escapeHtml(resume.location || "")}" /></div>
          <div><label class="field-label">Website / LinkedIn</label><input class="text-input" data-resume-field="website" value="${escapeHtml(resume.website || "")}" /></div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-head"><h3>Summary & skills</h3></div>
        <label class="field-label">Professional summary</label>
        <textarea class="text-input" data-resume-field="summary">${escapeHtml(resume.summary || "")}</textarea>
        <label class="field-label" style="margin-top:11px">Skills — comma separated</label>
        <textarea class="text-input" data-resume-field="skills" style="min-height:58px">${escapeHtml((resume.skills || []).join(", "))}</textarea>
      </div>

      <div class="form-section">
        <div class="form-section-head">
          <h3>Experience</h3>
          <button class="add-exp" type="button" data-action="add-experience" style="padding:0 10px;height:28px">${icon("plus")}Add role</button>
        </div>
        <div class="exp-editor" id="experienceEditor">
          ${(resume.experience || []).map((role, index) => experienceItemHtml(role, index)).join("")}
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-head"><h3>Education & certifications</h3></div>
        <label class="field-label">Education — one per line: School | Degree | Dates</label>
        <textarea class="text-input" data-resume-field="education" style="min-height:70px">${escapeHtml((resume.education || []).map((edu) => `${edu.school || ""} | ${edu.degree || ""} | ${edu.dates || ""}`).join("\n"))}</textarea>
        <label class="field-label" style="margin-top:11px">Certifications — one per line</label>
        <textarea class="text-input" data-resume-field="certifications" style="min-height:58px">${escapeHtml((resume.certifications || []).join("\n"))}</textarea>
      </div>`;
    openModal("resume");
  }

  function renumberExperience() {
    $$("[data-exp-item]", $("#experienceEditor")).forEach((item, index) => {
      const label = $(".exp-item-top strong", item);
      if (label) label.textContent = `Role ${index + 1}`;
    });
  }

  function saveResumeFromEditor(event) {
    event.preventDefault();
    const field = (name) => {
      const input = $(`[data-resume-field="${name}"]`, $("#resumeFormBody"));
      return input ? input.value.trim() : "";
    };
    const name = field("name");
    const title = field("title");
    if (!name || !title) {
      showToast("Add a name and title", "These are required for every tailored resume.", "error");
      return;
    }

    const experience = $$("[data-exp-item]", $("#experienceEditor")).map((item) => {
      const get = (name) => {
        const input = $(`[data-exp-field="${name}"]`, item);
        return input ? input.value.trim() : "";
      };
      return {
        company: get("company"),
        title: get("title"),
        dates: get("dates"),
        location: get("location"),
        bullets: get("bullets").split("\n").map((line) => line.trim()).filter(Boolean),
      };
    }).filter((role) => role.title || role.company || role.bullets.length);

    const education = field("education").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      return { school: parts[0] || "", degree: parts[1] || "", dates: parts[2] || "" };
    });

    state.resume = {
      name,
      title,
      email: field("email"),
      phone: field("phone"),
      location: field("location"),
      website: field("website"),
      summary: field("summary"),
      skills: field("skills").split(/[,\n]/).map((skill) => skill.trim()).filter(Boolean),
      experience,
      education,
      certifications: field("certifications").split("\n").map((line) => line.trim()).filter(Boolean),
    };
    resumeRevision += 1;
    analysisCache.clear();
    saveState();
    renderResumeOverview();
    updateChrome();
    closeModal("resume");
    showToast("Master resume updated", "Future tailored resumes will use these facts.");
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Could not load the parser.")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => {
        script.dataset.loaded = "true";
        resolve();
      };
      script.onerror = () => reject(new Error("Could not load the parser. Check your internet connection."));
      document.head.appendChild(script);
    });
  }

  async function extractFileText(file) {
    const extension = file.name.split(".").pop().toLowerCase();
    if (extension === "pdf") {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
      if (!window.pdfjsLib) throw new Error("PDF parser unavailable.");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const rows = new Map();
        content.items.forEach((item) => {
          if (!item.str || !item.str.trim()) return;
          const y = Math.round(item.transform[5]);
          let key = null;
          for (const existing of rows.keys()) {
            if (Math.abs(existing - y) <= 3) {
              key = existing;
              break;
            }
          }
          if (key === null) {
            key = y;
            rows.set(key, []);
          }
          rows.get(key).push({ x: item.transform[4], width: item.width || 0, str: item.str });
        });
        const lines = Array.from(rows.entries())
          .sort((a, b) => b[0] - a[0])
          .map(([, parts]) => {
            const sorted = parts.sort((a, b) => a.x - b.x);
            return sorted
              .reduce((line, part, index) => {
                if (index === 0) return part.str;
                const previous = sorted[index - 1];
                const gap = part.x - (previous.x + previous.width);
                const needsSpace = gap > 1.5 && !/\s$/.test(line) && !/^\s/.test(part.str);
                return line + (needsSpace ? " " : "") + part.str;
              }, "")
              .replace(/[ \t]{2,}/g, " ")
              .trim();
          })
          .filter(Boolean);
        pages.push(lines.join("\n"));
      }
      return pages.join("\n");
    }
    if (extension === "docx") {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
      if (!window.mammoth) throw new Error("DOCX parser unavailable.");
      const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return result.value || "";
    }
    return file.text();
  }

  async function handleResumeFile(file) {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      showToast("File too large", "Keep the resume under 6 MB.", "error");
      return;
    }
    const extension = file.name.split(".").pop().toLowerCase();
    if (!["pdf", "docx", "txt", "md", "json"].includes(extension)) {
      showToast("Unsupported file", "Use PDF, DOCX, TXT, MD or JSON.", "error");
      return;
    }
    try {
      if (extension === "json") {
        const parsed = JSON.parse(await file.text());
        const resume = parsed.resume || parsed;
        if (!resume || !Array.isArray(resume.experience)) throw new Error("That JSON does not look like a resume.");
        state.resume = resume;
        resumeRevision += 1;
        analysisCache.clear();
        saveState();
        renderResumeOverview();
        updateChrome();
        openResumeEditor();
        showToast("Resume imported", "Review the structured sections before saving.");
        return;
      }
      showToast("Importing resume", `Reading ${file.name} and extracting the structure…`, "info");
      const text = await extractFileText(file);
      if (!text || text.trim().length < 40) throw new Error("We couldn't find readable text in that file.");
      const parsed = parseResumeText(text);
      state.resume = parsed;
      resumeRevision += 1;
      analysisCache.clear();
      saveState();
      renderResumeOverview();
      updateChrome();
      openResumeEditor();
      showToast("Resume imported", "Check the parsed sections and correct anything that drifted.");
    } catch (error) {
      console.error("Resume import failed:", error);
      showToast("Import failed", error.message || "Try a different file or paste the content into the editor.", "error");
    } finally {
      const input = $("#resumeFileInput");
      if (input) input.value = "";
    }
  }

  function parseRoleHeader(header, fallbackTitle) {
    const parts = header
      .split(/\s*[|•]\s*|\s+[—–]\s+|\s+at\s+/i)
      .map((part) => part.trim())
      .filter(Boolean);
    const yearParts = parts.filter((part) => /\b(19|20)\d{2}\b/.test(part));
    const nonYear = parts.filter((part) => !/\b(19|20)\d{2}\b/.test(part));
    const titleLike = (value) => /(manager|analyst|engineer|designer|developer|lead|director|consultant|intern|specialist|architect|scientist|officer|head)/i.test(value);
    let title = nonYear.find(titleLike) || nonYear[0] || fallbackTitle;
    const company = nonYear.find((part) => part !== title) || "";
    let dates = yearParts.join(" · ");
    if (!dates) {
      const found = header.match(/\b(?:19|20)\d{2}\b[^|•\n]{0,24}/g);
      dates = found ? found.join(" · ") : "";
    }
    return {
      title: title || fallbackTitle,
      company,
      dates,
      location: "",
      bullets: [],
    };
  }

  function parseExperienceSection(lines, fallbackTitle) {
    const roles = [];
    let current = null;
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const bullet = /^[•\-*–—]\s+/.test(raw);
      const clean = raw.replace(/^[•\-*–—]\s+/, "").trim();
      if (!clean) continue;

      if (bullet) {
        if (!current) current = { company: "", title: fallbackTitle, dates: "", location: "", bullets: [] };
        current.bullets.push(clean);
        continue;
      }

      const yearHere = /\b(19|20)\d{2}\b/.test(clean);
      const nextRaw = lines[index + 1] || "";
      const nextClean = nextRaw.replace(/^[•\-*–—]\s+/, "").trim();
      const yearNext = /\b(19|20)\d{2}\b/.test(nextClean);
      const looksLikeHeader = (yearHere || yearNext) && clean.length < 120 && !/[.!?]$/.test(clean);

      if (looksLikeHeader) {
        if (current) roles.push(current);
        let header = clean;
        if (!yearHere && yearNext) {
          header = `${clean} | ${nextClean}`;
          index += 1;
        }
        current = parseRoleHeader(header, fallbackTitle);
        continue;
      }

      if (current && current.bullets.length === 0 && clean.length < 90 && !/[.!?]$/.test(clean) && (!current.company || current.company.length < 2)) {
        if (!current.company) current.company = clean;
        else current.location = clean;
        continue;
      }

      if (!current) current = { company: "", title: fallbackTitle, dates: "", location: "", bullets: [] };
      if (clean.length > 8) current.bullets.push(clean);
    }
    if (current) roles.push(current);

    let filtered = roles.filter((role) => role.bullets.length || role.company || role.title);
    if (!filtered.length) {
      const bullets = lines
        .filter((line) => !/^(experience|employment|work experience)$/i.test(line))
        .map((line) => line.replace(/^[•\-*–—]\s+/, "").trim())
        .filter((line) => line.length > 25);
      if (bullets.length) filtered = [{ company: "", title: fallbackTitle, dates: "", location: "", bullets }];
    }
    return filtered.slice(0, 6).map((role) => ({ ...role, bullets: role.bullets.slice(0, 8) }));
  }

  function parseResumeText(raw) {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const fullText = lines.join("\n");

    const email = (fullText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) || [])[0] || state.resume.email || "";
    const phone = (fullText.match(/(?:\+?\d[\d\s().-]{8,}\d)/) || [])[0]?.trim() || state.resume.phone || "";
    const website =
      (fullText.match(/(?:https?:\/\/|linkedin\.com\/|github\.com\/)[^\s|,]+/i) || [])[0] || state.resume.website || "";
    const locationMatch = fullText.match(/\b(Mumbai|Bengaluru|Bangalore|Delhi|Gurugram|Noida|Pune|Hyderabad|Chennai|Kolkata|Remote|India)\b[^\n|,]{0,28}/i);
    const location = locationMatch ? locationMatch[0].trim() : state.resume.location || "";

    let name = lines[0] || state.resume.name || "Your name";
    if (name.length > 55 || /@|https?:|linkedin|\b(19|20)\d{2}\b/i.test(name) || /resume|curriculum vitae|biodata/i.test(name)) {
      name = state.resume.name || "Your name";
    }
    let title = state.resume.title || "";
    if (lines[1] && lines[1].length < 80 && !/@|https?:|linkedin|\b(19|20)\d{2}\b/i.test(lines[1]) && !/summary|profile|experience|education|skills/i.test(lines[1])) {
      title = lines[1];
    }

    const headings = [
      { key: "summary", re: /^(professional\s+)?(summary|profile|objective)\b/i },
      { key: "experience", re: /^(work\s+|professional\s+)?experience\b|^employment\b/i },
      { key: "skills", re: /^(core\s+|technical\s+|key\s+)?(skills|competencies)\b/i },
      { key: "education", re: /^education\b|^academics\b/i },
      { key: "certifications", re: /^certifications?\b|^licenses?\b/i },
    ];
    const sections = { summary: [], experience: [], skills: [], education: [], certifications: [] };
    let current = null;
    lines.forEach((line) => {
      if (line.length < 70) {
        const heading = headings.find((item) => item.re.test(line));
        if (heading) {
          current = heading.key;
          const rest = line.replace(heading.re, "").replace(/^[:\s–—-]+/, "").trim();
          if (rest) sections[current].push(rest);
          return;
        }
      }
      if (current) sections[current].push(line);
    });

    const summary = sections.summary.join(" ").trim() || state.resume.summary || "";
    const skills = sections.skills
      .flatMap((line) => line.replace(/^[•\-*–—]\s+/, "").split(/[,;|•·]/))
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 1 && skill.length < 38);
    const experience = parseExperienceSection(sections.experience, title);
    const education = sections.education
      .filter((line) => line.length > 3)
      .map((line) => {
        const parts = line.replace(/^[•\-*–—]\s+/, "").split(/\s*[|•]\s*|\s+[—–]\s+/).map((part) => part.trim()).filter(Boolean);
        const dates = (line.match(/\b(19|20)\d{2}\b[^|•]{0,20}/g) || []).join(" · ");
        return {
          school: parts[0] || line,
          degree: parts[1] || "",
          dates,
        };
      })
      .slice(0, 4);
    const certifications = sections.certifications
      .map((line) => line.replace(/^[•\-*–—]\s+/, "").trim())
      .filter((line) => line.length > 2)
      .slice(0, 8);

    return {
      name,
      title,
      email,
      phone,
      location,
      website,
      summary,
      skills: Array.from(new Set(skills.length ? skills : state.resume.skills || [])),
      experience: experience.length ? experience : [],
      education: education.length ? education : state.resume.education || [],
      certifications: certifications.length ? certifications : [],
    };
  }

  function hydrateSearch() {
    if ($("#roleInput")) $("#roleInput").value = state.prefs.role || "";
    if ($("#locationInput")) $("#locationInput").value = state.prefs.location || "";
    if ($("#expSelect")) $("#expSelect").value = state.prefs.experience || "";
    if ($("#remoteToggle")) $("#remoteToggle").checked = Boolean(state.prefs.remote);
    if ($("#sortSelect")) $("#sortSelect").value = state.filters.sort || "match";
    $$("#filterChips .chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.tag === state.filters.tag);
    });
  }

  function hydratePrefsForm() {
    if ($("#prefRole")) $("#prefRole").value = state.prefs.role || "";
    if ($("#prefLocation")) $("#prefLocation").value = state.prefs.location || "";
    if ($("#prefExperience")) $("#prefExperience").value = state.prefs.experience || "";
    if ($("#prefRemote")) $("#prefRemote").value = state.prefs.remote ? "remote" : "any";
    if ($("#prefKeywords")) $("#prefKeywords").value = state.prefs.keywords || "";
  }

  function hydrateAiForm() {
    const provider = state.ai.provider || "freellmapi";
    if ($("#aiProvider")) $("#aiProvider").value = provider;
    if ($("#aiModel")) $("#aiModel").value = state.ai.model || ENGINE_DEFAULTS[provider];
    if ($("#aiKey")) $("#aiKey").value = (state.ai.keys && state.ai.keys[provider]) || "";
    if ($("#aiBaseUrl")) $("#aiBaseUrl").value = state.ai.baseUrl || FREELLMAPI_DEFAULT_URL;
    updateAiVisibility();
  }

  function updateAiVisibility() {
    const provider = $("#aiProvider") ? $("#aiProvider").value : "freellmapi";
    if ($("#aiBaseUrlField")) $("#aiBaseUrlField").classList.toggle("hidden", provider !== "freellmapi");
    if ($("#aiKey")) {
      $("#aiKey").placeholder = { freellmapi: "freellmapi-...", anthropic: "sk-ant-..." }[provider] || "sk-...";
    }
    if ($("#aiModel") && !$("#aiModel").value) {
      $("#aiModel").value = ENGINE_DEFAULTS[provider];
    }
  }

  function hydrateSettings() {
    hydratePrefsForm();
    hydrateAiForm();
    renderResumeOverview();
  }

  function setView(name, updateHash = true) {
    if (!["search", "dashboard", "settings"].includes(name)) return;
    currentView = name;
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    const labels = { search: "Discovery", dashboard: "Application board", settings: "Settings" };
    if ($("#topbarLabel")) $("#topbarLabel").textContent = labels[name];
    if (name === "dashboard") renderDashboard();
    if (name === "settings") {
      renderResumeOverview();
      hydratePrefsForm();
      hydrateAiForm();
    }
    updateChrome();
    closeSidebar();
    if (updateHash) {
      try { history.replaceState(null, "", `#${name}`); } catch (error) { /* file:// can be restricted */ }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSidebar() {
    $("#sidebar")?.classList.add("open");
    $("#sidebarScrim")?.classList.add("visible");
  }

  function closeSidebar() {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarScrim")?.classList.remove("visible");
  }

  function handleAction(action, el) {
    const jobId = el.dataset.jobId || "";
    switch (action) {
      case "workspace":
        showToast("Personal workspace", "Your workspace is stored locally in this browser.", "info");
        break;
      case "notifications":
        showToast("You're all caught up", "No new alerts. Your next best action is to tailor a role or update a card.", "info");
        break;
      case "job-save": {
        if (!jobId) return;
        const app = getApp(jobId);
        if (!app) {
          ensureApp(jobId, "saved");
          saveState();
          renderJobs();
          renderDashboard();
          updateChrome();
          showToast("Role saved", "Added to the Saved column on your board.");
        } else if (app.status === "saved") {
          state.applications = state.applications.filter((item) => item.jobId !== jobId);
          saveState();
          renderJobs();
          renderDashboard();
          updateChrome();
          showToast("Removed from saved", "The role is untracked again.", "info");
        } else {
          openTrack(jobId);
        }
        break;
      }
      case "job-tailor":
        openTailor(jobId);
        break;
      case "clear-filters":
        state.prefs = { ...state.prefs, role: "", location: "", experience: "", remote: false };
        state.filters = { ...state.filters, tag: "All", sort: "match" };
        saveState();
        hydrateSearch();
        renderJobs();
        updateChrome();
        showToast("Filters cleared", "Showing every role in your feed.", "info");
        break;
      case "toggle-jd": {
        const wrap = $("#sideJd");
        if (wrap) {
          const open = wrap.classList.toggle("open");
          const button = $(".jd-toggle", wrap);
          if (button) button.textContent = open ? "Collapse JD ↙" : "Read full JD ↗";
        }
        break;
      }
      case "apply-now":
      case "open-posting":
        if (jobId) applyToJob(jobId);
        break;
      case "regenerate":
        if (jobId) openTailor(jobId, { regenerate: true });
        break;
      case "view-board": {
        closeAllModals();
        setView("dashboard");
        if (jobId) {
          setTimeout(() => {
            const card = $(`.app-card[data-job-id="${jobId}"]`);
            if (card) card.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          }, 250);
        }
        break;
      }
      case "view-track":
        closeModal("tailor");
        if (jobId) openTrack(jobId);
        break;
      case "view-tailored":
        closeModal("track");
        if (jobId) openTailor(jobId, { existing: true });
        break;
      case "tailor-from-track":
        closeModal("track");
        if (jobId) openTailor(jobId, { regenerate: true });
        break;
      case "open-track":
        if (jobId) openTrack(jobId);
        break;
      case "track-status": {
        if (!jobId) return;
        persistTrackDraft();
        const nextStatus = el.dataset.status;
        setStatus(jobId, nextStatus);
        renderTrack(jobId);
        showToast("Stage updated", `Moved to ${STATUS_MAP[nextStatus].label}.`);
        break;
      }
      case "save-track":
        if (jobId) saveTrackNotes(jobId);
        break;
      case "remove-app":
        if (jobId) removeApplication(jobId);
        break;
      case "open-attachment":
        openAttachment();
        break;
      case "export-data":
        downloadJsonBackup();
        break;
      case "reset": {
        if (!confirm("Reset the AutoMatch workspace?\n\nThis clears applications, notes, settings, API keys and your resume from this browser.")) return;
        localStorage.removeItem(STORAGE_KEY);
        state = defaultState();
        resumeRevision += 1;
        analysisCache.clear();
        closeAllModals();
        hydrateSearch();
        hydrateSettings();
        renderJobs();
        renderDashboard();
        updateChrome();
        setView("search");
        showToast("Workspace reset", "Applications, notes, resume and settings were cleared.");
        break;
      }
      case "add-experience": {
        const editor = $("#experienceEditor");
        if (!editor) return;
        const count = $$("[data-exp-item]", editor).length;
        const wrapper = document.createElement("div");
        wrapper.innerHTML = experienceItemHtml({}, count).trim();
        editor.appendChild(wrapper.firstElementChild);
        renumberExperience();
        break;
      }
      case "remove-experience": {
        const item = el.closest("[data-exp-item]");
        if (item) item.remove();
        renumberExperience();
        break;
      }
      case "check-obscura":
        checkObscura(true);
        break;
      default:
        break;
    }
  }

  function normalizeImportedJob(raw) {
    const palette = [
      ["#e8c77a", "#c9a14a"],
      ["#f0d49a", "#c08a4e"],
      ["#b4cb92", "#8fae6b"],
      ["#f0b45e", "#e6907f"],
      ["#d8c08a", "#8a6a2a"],
    ];
    const seed = String(raw.company || raw.title || "job")
      .split("")
      .reduce((total, char) => total + char.charCodeAt(0), 0);
    const description = String(raw.description || "").replace(/\s+/g, " ").trim();
    return {
      id: String(raw.id || `live-${Date.now()}`),
      title: String(raw.title || "Imported role").trim(),
      company: String(raw.company || "Unknown company").trim(),
      logo: String(raw.logo || String(raw.company || "J").trim().charAt(0) || "J").toUpperCase().slice(0, 2),
      brand: Array.isArray(raw.brand) && raw.brand.length === 2 ? raw.brand : palette[seed % palette.length],
      location: String(raw.location || "Not specified"),
      mode: raw.mode || (raw.remote ? "Remote" : "On-site"),
      remote: Boolean(raw.remote) || /remote/i.test(String(raw.location || "")),
      type: String(raw.type || "Full-time"),
      experience: String(raw.experience || "Not specified"),
      salary: String(raw.salary || "Not disclosed"),
      postedHours: Number.isFinite(Number(raw.postedHours)) ? Number(raw.postedHours) : 1,
      source: String(raw.source || "Imported link"),
      category: String(raw.category || "Imported"),
      team: String(raw.team || "Imported role"),
      skills: Array.isArray(raw.skills) ? raw.skills.filter(Boolean).map(String).slice(0, 12) : [],
      description: description || "Imported from a job posting. Open the original link for the full description.",
      url: String(raw.url || ""),
      importedAt: raw.importedAt || new Date().toISOString(),
    };
  }

  async function importJobFromUrl(url) {
    const button = $("#obscuraImportBtn");
    const original = button ? button.innerHTML : "";
    if (button) {
      button.disabled = true;
      button.innerHTML = `${icon("refresh")}Importing…`;
    }
    try {
      const response = await fetch("api/job-from-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.jobs) || !data.jobs.length) {
        throw new Error(data.error || data.message || "The bridge could not find a JobPosting on that page.");
      }
      const incoming = data.jobs.map(normalizeImportedJob).filter((job) => job.title && job.url);
      const seen = new Set();
      state.imported = [...incoming, ...(state.imported || [])]
        .filter((job) => {
          const key = job.url.replace(/#.*$/, "");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 20);
      analysisCache.clear();
      saveState();
      renderJobs();
      updateChrome();
      setView("search");
      const first = state.imported[0];
      showToast("Role imported", `${first.company} · ${first.title} is now in Discovery.`);
    } catch (error) {
      const hint = /Failed to fetch|NetworkError/i.test(error.message || "")
        ? "Start the local bridge with `node server.js`, then try again."
        : error.message;
      showToast("Import failed", hint, "error");
      console.error("Obscura import failed:", error);
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = original;
      }
    }
  }

  async function checkObscura(manual = false) {
    const status = $("#obscuraStatus");
    if (!status) return;
    status.setAttribute("data-action", "check-obscura");
    status.setAttribute("role", "button");
    status.setAttribute("tabindex", "0");
    status.style.cursor = "pointer";
    status.title = "Click to re-check the local Obscura bridge";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const response = await fetch("api/health", { cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error("Bridge unavailable");
      const data = await response.json();
      if (data && data.obscura) {
        status.textContent = "Bridge online";
        status.classList.add("online");
        if (manual) showToast("Obscura bridge online", "Live scraping is available through the local server.", "info");
      } else {
        status.textContent = "Bridge online · scraper missing";
        status.classList.remove("online");
        if (manual) showToast("Bridge found", "The server is running, but Obscura is not on PATH.", "info");
      }
    } catch (error) {
      status.textContent = "Not connected";
      status.classList.remove("online");
      if (manual) showToast("Bridge offline", "Run `node server.js` and make sure the Obscura CLI is installed. See README.md.", "info");
    }
  }

  function bindEvents() {
    $("#searchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      state.prefs = {
        ...state.prefs,
        role: ($("#roleInput")?.value || "").trim(),
        location: ($("#locationInput")?.value || "").trim(),
        experience: $("#expSelect")?.value || "",
        remote: Boolean($("#remoteToggle")?.checked),
      };
      saveState();
      renderJobs();
      updateChrome();
      const count = filteredJobs().length;
      if (!count) showToast("No exact matches", "Try clearing the location or broadening the role.", "info");
    });

    $("#filterChips")?.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      state.filters.tag = chip.dataset.tag || "All";
      $$("#filterChips .chip").forEach((item) => item.classList.toggle("active", item === chip));
      saveState();
      renderJobs();
      updateChrome();
    });

    $("#sortSelect")?.addEventListener("change", (event) => {
      state.filters.sort = event.target.value;
      saveState();
      renderJobs();
      updateChrome();
    });

    $("#prefsForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      state.prefs = {
        role: ($("#prefRole")?.value || "").trim(),
        location: ($("#prefLocation")?.value || "").trim(),
        experience: $("#prefExperience")?.value || "",
        remote: $("#prefRemote")?.value === "remote",
        keywords: ($("#prefKeywords")?.value || "").trim(),
      };
      saveState();
      hydrateSearch();
      renderJobs();
      updateChrome();
      showToast("Search defaults saved", "Discovery now starts from these preferences.");
    });

    $("#aiProvider")?.addEventListener("change", (event) => {
      const provider = event.target.value;
      if ($("#aiModel")) $("#aiModel").value = ENGINE_DEFAULTS[provider] || "";
      if ($("#aiKey")) $("#aiKey").value = (state.ai.keys && state.ai.keys[provider]) || "";
      updateAiVisibility();
    });

    $("#aiForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const provider = $("#aiProvider")?.value || "freellmapi";
      const key = ($("#aiKey")?.value || "").trim();
      const model = ($("#aiModel")?.value || "").trim() || ENGINE_DEFAULTS[provider];
      const baseUrl = ($("#aiBaseUrl")?.value || "").trim() || FREELLMAPI_DEFAULT_URL;
      if (provider === "freellmapi" && !/^https?:\/\/\S+$/i.test(baseUrl)) {
        showToast("Check the base URL", "Use the full address, for example http://localhost:3001/v1.", "error");
        return;
      }
      if (!key) {
        showToast("Add an API key", "Paste the key for the selected provider.", "error");
        return;
      }
      state.ai = {
        provider,
        model,
        keys: { ...(state.ai.keys || {}), [provider]: key },
        baseUrl,
      };
      saveState();
      updateAiVisibility();
      showToast("AI engine connected", "Keys stay in this browser. Calls go directly to the provider.");
    });

    $("#editResumeBtn")?.addEventListener("click", openResumeEditor);
    $("#uploadResumeBtn")?.addEventListener("click", () => $("#resumeFileInput")?.click());
    $("#uploadZone")?.addEventListener("click", () => $("#resumeFileInput")?.click());
    $("#resumeFileInput")?.addEventListener("change", (event) => handleResumeFile(event.target.files?.[0]));

    const uploadZone = $("#uploadZone");
    if (uploadZone) {
      ["dragenter", "dragover"].forEach((name) => {
        uploadZone.addEventListener(name, (event) => {
          event.preventDefault();
          uploadZone.classList.add("dragging");
        });
      });
      ["dragleave", "drop"].forEach((name) => {
        uploadZone.addEventListener(name, (event) => {
          event.preventDefault();
          uploadZone.classList.remove("dragging");
          if (name === "drop") handleResumeFile(event.dataTransfer?.files?.[0]);
        });
      });
    }

    $("#resumeForm")?.addEventListener("submit", saveResumeFromEditor);

    $("#obscuraImportForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("#obscuraUrl");
      const url = (input?.value || "").trim();
      if (!/^https?:\/\/\S+\.\S+/i.test(url)) {
        showToast("Add a job link", "Paste the full https:// URL of a public job posting.", "error");
        input?.focus();
        return;
      }
      importJobFromUrl(url);
    });
    $("#copyResumeBtn")?.addEventListener("click", copyTailoredResume);
    $("#downloadPdfBtn")?.addEventListener("click", downloadPdf);
    $("#downloadDocBtn")?.addEventListener("click", downloadWord);

    $("#menuBtn")?.addEventListener("click", openSidebar);
    $("#sidebarScrim")?.addEventListener("click", closeSidebar);

    $("#tailorModal")?.addEventListener("click", (event) => {
      const tab = event.target.closest(".tab[data-tab]");
      if (tab) switchTab(tab.dataset.tab);
    });

    const board = $("#kanbanBoard");
    if (board) {
      board.addEventListener("click", (event) => {
        if (dragJustEnded) return;
        if (event.target.closest("[data-action]")) return;
        const card = event.target.closest(".app-card");
        if (card) openTrack(card.dataset.jobId);
      });

      board.addEventListener("dragstart", (event) => {
        const card = event.target.closest(".app-card");
        if (!card) return;
        event.dataTransfer.setData("text/plain", card.dataset.jobId);
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });

      board.addEventListener("dragend", (event) => {
        const card = event.target.closest(".app-card");
        if (card) card.classList.remove("dragging");
        $$(".kanban-col", board).forEach((col) => col.classList.remove("drag-over"));
        dragJustEnded = true;
        setTimeout(() => { dragJustEnded = false; }, 180);
      });

      board.addEventListener("dragover", (event) => {
        const column = event.target.closest(".kanban-col");
        if (!column) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        $$(".kanban-col", board).forEach((col) => col.classList.toggle("drag-over", col === column));
      });

      board.addEventListener("dragleave", (event) => {
        const column = event.target.closest(".kanban-col");
        if (!column) return;
        if (event.relatedTarget && column.contains(event.relatedTarget)) return;
        column.classList.remove("drag-over");
      });

      board.addEventListener("drop", (event) => {
        const column = event.target.closest(".kanban-col");
        if (!column) return;
        event.preventDefault();
        column.classList.remove("drag-over");
        const jobId = event.dataTransfer.getData("text/plain");
        const app = getApp(jobId);
        const nextStatus = column.dataset.status;
        if (!app || !nextStatus || app.status === nextStatus) return;
        dragJustEnded = true;
        setStatus(jobId, nextStatus);
        showToast("Card moved", `${allJobs().find((job) => job.id === jobId)?.company || "Application"} moved to ${STATUS_MAP[nextStatus].label}.`);
        setTimeout(() => { dragJustEnded = false; }, 220);
      });
    }

    document.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close]");
      if (close) {
        closeModal(close.dataset.close);
        return;
      }
      const view = event.target.closest("[data-view]");
      if (view && !event.target.closest("[data-action]")) {
        event.preventDefault();
        setView(view.dataset.view);
        return;
      }
      const action = event.target.closest("[data-action]");
      if (action) {
        handleAction(action.dataset.action, action);
      }
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        closeAllModals();
        setView("search");
        setTimeout(() => $("#roleInput")?.focus(), 80);
        return;
      }
      if (event.key === "Escape") {
        if (!$("#resumeModal").hidden) return closeModal("resume");
        if (!$("#trackModal").hidden) return closeModal("track");
        if (!$("#tailorModal").hidden) return closeModal("tailor");
        return closeSidebar();
      }
      const tag = (event.target.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (["1", "2", "3"].includes(event.key)) {
        setView({ "1": "search", "2": "dashboard", "3": "settings" }[event.key]);
      }
    });

    window.addEventListener("beforeunload", saveState);
  }

  function init() {
    bindEvents();
    hydrateSearch();
    hydrateSettings();
    renderJobs();
    renderDashboard();
    updateChrome();
    const hash = (location.hash || "").replace("#", "");
    setView(["search", "dashboard", "settings"].includes(hash) ? hash : "search", false);
    checkObscura(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
