/* ============================================================
   AutoMatch AI — live job search
   GET /api/jobs?q=product+manager&location=Bengaluru&remote=1&page=1
   Proxies JSearch (RapidAPI) so the API key stays on the server.
   Works as a Vercel function and through the local server.js.
   ============================================================ */

const JSEARCH_URL = "https://jsearch.p.rapidapi.com/search";
const DATE_FILTERS = new Set(["all", "today", "3days", "week", "month"]);

function send(res, status, payload, cacheControl = "no-store") {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", cacheControl);
  res.end(JSON.stringify(payload));
}

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function employmentType(job) {
  const map = { FULLTIME: "Full-time", PARTTIME: "Part-time", CONTRACTOR: "Contract", INTERN: "Internship" };
  const list = Array.isArray(job.job_employment_types) ? job.job_employment_types : [];
  const raw = (list[0] || job.job_employment_type || "").toString().toUpperCase().replace(/[^A-Z]/g, "");
  return map[raw] || (raw.startsWith("CONTRACT") ? "Contract" : "Full-time");
}

function seniority(title) {
  if (/\b(lead|principal|head|director|staff|vp)\b/i.test(title)) return "Lead";
  if (/\b(senior|sr\.?)\b/i.test(title)) return "Senior";
  return "Not specified";
}

function category(text) {
  if (/\b(fintech|payments?|lending|banking|credit|upi|insurance)\b/i.test(text)) return "Fintech";
  if (/\b(machine learning|ml engineer|deep learning|llm|generative ai|artificial intelligence|data scien)/i.test(text)) return "AI/ML";
  return "General";
}

function formatAmount(value, currency) {
  if (currency === "INR") {
    if (value >= 100000) return `${+(value / 100000).toFixed(1)}`;
    return `${Math.round(value / 1000)}K`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(Math.round(value));
}

function formatSalary(job) {
  const min = Number(job.job_min_salary) || 0;
  const max = Number(job.job_max_salary) || 0;
  const label = clean(job.job_salary_string, 60) || (typeof job.job_salary === "string" ? clean(job.job_salary, 60) : "");
  if (!min && !max) return label || "Not disclosed";
  // The API gives no currency, so only treat amounts as rupees for jobs located in India.
  const currency = String(job.job_salary_currency || (String(job.job_country).toUpperCase() === "IN" ? "INR" : "")).toUpperCase();
  if (currency !== "INR" && label) return label;
  const period = String(job.job_salary_period || "").toUpperCase();
  const range = [min, max].filter(Boolean).map((value) => formatAmount(value, currency)).join("–");
  if (currency === "INR" && period === "YEAR" && Math.max(min, max) >= 100000) return `₹${range} LPA`;
  const symbol = { INR: "₹", USD: "$", GBP: "£", EUR: "€" }[currency] || (currency ? `${currency} ` : "");
  const suffix = { YEAR: "/yr", MONTH: "/mo", HOUR: "/hr" }[period] || "";
  return `${symbol}${range}${suffix}`;
}

function postedHours(job) {
  const seconds = Number(job.job_posted_at_timestamp);
  const time = seconds ? seconds * 1000 : Date.parse(job.job_posted_at_datetime_utc || "");
  if (!Number.isFinite(time)) return 24;
  return Math.max(0, Math.round((Date.now() - time) / 3_600_000));
}

function mapJob(job) {
  const title = clean(job.job_title, 160);
  const description = String(job.job_description || "").slice(0, 12000);
  const remote = Boolean(job.job_is_remote);
  const location =
    clean(job.job_location, 120) ||
    [job.job_city, job.job_state, job.job_country].filter(Boolean).join(", ") ||
    (remote ? "Remote" : "Not specified");
  return {
    // job_id changes between requests for the same posting; job_uid is stable.
    id: `js-${String(job.job_uid || job.job_id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`,
    title,
    company: clean(job.employer_name, 120) || "Unknown company",
    location,
    remote,
    mode: remote ? "Remote" : "On-site",
    type: employmentType(job),
    experience: seniority(title),
    salary: formatSalary(job),
    postedHours: postedHours(job),
    source: clean(job.job_publisher, 60) || "JSearch",
    category: category(`${title} ${description}`),
    team: clean(job.job_publisher, 60) || "Live search",
    description,
    url: job.job_apply_link || job.job_google_link || "",
  };
}

function pickCity(value) {
  return (
    String(value || "")
      .split(/[\/,;|()]|\s+or\s+|\s+and\s+/i)
      .map((token) => token.trim())
      .filter((token) => token && !/^remote$/i.test(token) && !/^any(where)?$/i.test(token))
      .map((token) => clean(token, 60))
      .shift() || ""
  );
}

function looksRemote(value) {
  return /\bremote\b|\bwfh\b|\bwork from home\b/i.test(String(value || ""));
}

function readJobs(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.data?.jobs)) return body.data.jobs;
  if (Array.isArray(body.jobs)) return body.jobs;
  return [];
}

const ENDPOINTS = [
  { url: "https://jsearch.p.rapidapi.com/search-v2", host: "jsearch.p.rapidapi.com" },
  { url: "https://jsearch.p.rapidapi.com/search", host: "jsearch.p.rapidapi.com" },
  { url: "https://jsearch-mega.p.rapidapi.com/search", host: "jsearch-mega.p.rapidapi.com" },
];

async function queryJSearch({ key, query, page, cursor, country, date, remoteOnly, signal }) {
  let lastStatus = 0;
  let lastDetail = "";
  for (const endpoint of ENDPOINTS) {
    const upstream = new URL(endpoint.url);
    const isV2 = endpoint.url.endsWith("/search-v2");
    upstream.searchParams.set("query", query);
    // search-v2 ignores `page` for later results and returns repeats; it paginates with a cursor.
    if (isV2 && cursor) upstream.searchParams.set("cursor", cursor);
    else if (!isV2 || page > 1) upstream.searchParams.set("page", String(page));
    upstream.searchParams.set("num_pages", "1");
    upstream.searchParams.set("country", country);
    upstream.searchParams.set("date_posted", date);
    if (remoteOnly) {
      upstream.searchParams.set("work_from_home", "true");
      upstream.searchParams.set("remote_jobs_only", "true");
    }

    const response = await fetch(upstream.toString(), {
      signal,
      headers: { "x-rapidapi-key": key, "x-rapidapi-host": endpoint.host },
    });

    if (response.ok) {
      const body = await response.json();
      return { ok: true, jobs: readJobs(body), cursor: isV2 ? String(body?.data?.cursor || "") : "", status: 200, detail: "" };
    }

    lastStatus = response.status;
    if (response.status === 404) {
      // This path is not active for the account's subscription; try the next candidate.
      continue;
    }
    try {
      const body = await response.json();
      lastDetail = body?.message || body?.error?.message || JSON.stringify(body);
    } catch (error) {
      lastDetail = "";
    }
    // 401/403/429 are auth or quota problems: retrying other endpoints would waste quota.
    break;
  }
  return { ok: false, jobs: [], cursor: "", status: lastStatus, detail: lastDetail };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Use GET." });

  const key = process.env.JSEARCH_API_KEY;
  if (!key) {
    return send(res, 503, { ok: false, error: "Live search is not configured. Set the JSEARCH_API_KEY environment variable." });
  }

  const params = new URL(req.url || "/", "http://localhost").searchParams;
  const q = clean(params.get("q"), 120);
  const location = clean(params.get("location"), 80);
  const remote = params.get("remote") === "1";
  const page = Math.min(10, Math.max(1, parseInt(params.get("page"), 10) || 1));
  const date = DATE_FILTERS.has(params.get("date")) ? params.get("date") : "month";
  const countryParam = (params.get("country") || process.env.JSEARCH_COUNTRY || "in").toLowerCase();
  const country = /^[a-z]{2}$/.test(countryParam) ? countryParam : "in";

  if (q.length < 2) return send(res, 400, { ok: false, error: "Enter a role, skill or company to search." });

  const city = pickCity(location);
  const remoteOnly = remote || looksRemote(location);
  const cursor = String(params.get("cursor") || "").slice(0, 4000);
  const searchedQuery = clean(params.get("sq"), 200);

  // Try the focused query first. If the city narrows it to nothing, retry nationwide
  // so a typo or an unusual city name does not leave the feed empty.
  // A cursor belongs to the exact query that produced it, so "load more" reuses that query.
  const attempts = cursor && searchedQuery ? [searchedQuery] : city ? [`${q} in ${city}`, q] : [q];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    let result = null;
    let usedQuery = attempts[0];
    for (const query of attempts) {
      usedQuery = query;
      result = await queryJSearch({ key, query, page, cursor, country, date, remoteOnly, signal: controller.signal });
      if (!result.ok || result.jobs.length) break;
    }

    if (!result || !result.ok) {
      const status = result?.status || 0;
      const messages = {
        401: "JSearch rejected the API key. Check JSEARCH_API_KEY.",
        403: "JSearch rejected the API key or you are not subscribed to the JSearch plan on RapidAPI.",
        404: "JSearch endpoint not found. The API might have changed or the URL is incorrect.",
        429: "JSearch quota or rate limit reached. Try again later.",
      };
      return send(res, 502, {
        ok: false,
        error: messages[status] || `JSearch returned ${status || "an error"}.`,
        detail: result?.detail || "",
      });
    }

    const seen = new Set();
    const jobs = result.jobs
      .map((job) => mapJob(job))
      .filter((job) => job.title && job.url && job.id !== "js-")
      .filter((job) => !seen.has(job.id) && seen.add(job.id));

    const hasMore = result.cursor ? jobs.length > 0 : jobs.length >= 10;
    return send(
      res,
      200,
      { ok: true, query: q, searchedQuery: usedQuery, location, city, page, jobs, hasMore, cursor: result.cursor },
      "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400"
    );
  } catch (error) {
    const message = error.name === "AbortError" ? "JSearch took too long to respond." : "Could not reach JSearch.";
    return send(res, 504, { ok: false, error: message, detail: error.message || "" });
  } finally {
    clearTimeout(timer);
  }
};
