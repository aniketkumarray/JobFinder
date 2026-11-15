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

function employmentType(value) {
  const map = { FULLTIME: "Full-time", PARTTIME: "Part-time", CONTRACTOR: "Contract", INTERN: "Internship" };
  const first = String(value || "").split(/[,\s]+/)[0].toUpperCase();
  return map[first] || "Full-time";
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

function formatSalary(job, country) {
  const min = Number(job.job_min_salary) || 0;
  const max = Number(job.job_max_salary) || 0;
  if (!min && !max) return typeof job.job_salary === "string" && job.job_salary.trim() ? job.job_salary.trim() : "Not disclosed";
  const currency = String(job.job_salary_currency || (country === "in" ? "INR" : "")).toUpperCase();
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

function mapJob(job, country) {
  const title = clean(job.job_title, 160);
  const description = String(job.job_description || "").slice(0, 12000);
  const remote = Boolean(job.job_is_remote);
  const location =
    clean(job.job_location, 120) ||
    [job.job_city, job.job_state, job.job_country].filter(Boolean).join(", ") ||
    (remote ? "Remote" : "Not specified");
  return {
    id: `js-${String(job.job_id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`,
    title,
    company: clean(job.employer_name, 120) || "Unknown company",
    location,
    remote,
    mode: remote ? "Remote" : "On-site",
    type: employmentType(job.job_employment_type),
    experience: seniority(title),
    salary: formatSalary(job, country),
    postedHours: postedHours(job),
    source: clean(job.job_publisher, 60) || "JSearch",
    category: category(`${title} ${description}`),
    team: clean(job.job_publisher, 60) || "Live search",
    description,
    url: job.job_apply_link || job.job_google_link || "",
  };
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

  const candidateConfigs = [
    { url: "https://jsearch.p.rapidapi.com/search-v2", host: "jsearch.p.rapidapi.com" },
    { url: "https://jsearch.p.rapidapi.com/search", host: "jsearch.p.rapidapi.com" },
    { url: "https://jsearch-mega.p.rapidapi.com/search", host: "jsearch-mega.p.rapidapi.com" },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  
  try {
    let response = null;
    let lastErrorDetail = "";
    let lastStatus = 0;

    for (const config of candidateConfigs) {
      const upstream = new URL(config.url);
      upstream.searchParams.set("query", location && !/^remote$/i.test(location) ? `${q} in ${location}` : q);
      upstream.searchParams.set("page", String(page));
      upstream.searchParams.set("num_pages", "1");
      upstream.searchParams.set("country", country);
      upstream.searchParams.set("date_posted", date);
      if (remote || /^remote$/i.test(location)) {
        upstream.searchParams.set("work_from_home", "true");
        upstream.searchParams.set("remote_jobs_only", "true");
      }

      response = await fetch(upstream.toString(), {
        signal: controller.signal,
        headers: { "x-rapidapi-key": key, "x-rapidapi-host": config.host },
      });

      if (response.ok) break;

      lastStatus = response.status;
      if (response.status === 404) {
        // 404 means this endpoint route/host combination is not active for this account/subscription, try next candidate
        continue;
      } else {
        // 401, 403, 429 etc are fatal auth/quota errors so don't retry endpoints
        try {
          const errBody = await response.json();
          lastErrorDetail = errBody.message || JSON.stringify(errBody);
        } catch (e) {}
        break;
      }
    }

    if (!response || !response.ok) {
      const status = response ? response.status : lastStatus;
      const messages = {
        401: "JSearch rejected the API key. Check JSEARCH_API_KEY.",
        403: "JSearch rejected the API key or you are not subscribed to the JSearch plan on RapidAPI.",
        404: "JSearch endpoint not found. The API might have changed or the URL is incorrect.",
        429: "JSearch quota or rate limit reached. Try again later.",
      };
      return send(res, 502, { 
        ok: false, 
        error: messages[status] || `JSearch returned ${status}.`,
        detail: lastErrorDetail
      });
    }

    const body = await response.json();
    const rawJobs = Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.data?.jobs)
      ? body.data.jobs
      : Array.isArray(body.jobs)
      ? body.jobs
      : [];

    const jobs = rawJobs
      .map((job) => mapJob(job, country))
      .filter((job) => job.title && job.url && job.id !== "js-");

    return send(
      res,
      200,
      { ok: true, query: q, location, page, jobs, hasMore: jobs.length >= 10 },
      "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400"
    );
  } catch (error) {
    const message = error.name === "AbortError" ? "JSearch took too long to respond." : "Could not reach JSearch.";
    return send(res, 504, { ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
};
