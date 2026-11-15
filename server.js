/* ============================================================
   AutoMatch AI — optional local bridge
   Serves the app and exposes two scraping helpers backed
   by Obscura (https://github.com/h4ckf0r0day/obscura).

   Run:  node server.js
   Open: http://127.0.0.1:4173
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = "127.0.0.1";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

let healthCache = { at: 0, value: null };

function runObscura(args, timeout = 35_000) {
  return new Promise((resolve, reject) => {
    execFile("obscura", args, { timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const hint = /ENOENT/i.test(error.message)
          ? "The `obscura` CLI was not found on PATH. Download it from https://github.com/h4ckf0r0day/obscura/releases and restart the server."
          : stderr.trim() || error.message;
        return reject(new Error(hint));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function obscuraHealth(force = false) {
  if (!force && healthCache.value && Date.now() - healthCache.at < 10_000) return healthCache.value;
  let value = { obscura: false, version: null, error: null };
  try {
    const { stdout, stderr } = await runObscura(["--version"], 4_000);
    value = {
      obscura: true,
      version: (stdout || stderr).trim().split(/\r?\n/)[0].slice(0, 160),
      error: null,
    };
  } catch (error) {
    value = { obscura: false, version: null, error: error.message };
  }
  healthCache = { at: Date.now(), value };
  return value;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 30_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function safePublicUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("Provide a valid http(s) URL.");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  if (blocked) throw new Error("Private and local network URLs are blocked by the bridge.");
  return parsed.toString();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function formatLocation(location) {
  if (!location) return "Not specified";
  const entries = Array.isArray(location) ? location : [location];
  return entries
    .map((entry) => {
      const address = entry.address || entry;
      if (typeof address === "string") return address;
      return [address.addressLocality, address.addressRegion, address.addressCountry]
        .filter(Boolean)
        .join(", ");
    })
    .filter(Boolean)
    .join(" / ") || "Not specified";
}

function collectJobPostings(node, bucket = []) {
  if (!node || typeof node !== "object") return bucket;
  if (Array.isArray(node)) {
    node.forEach((entry) => collectJobPostings(entry, bucket));
    return bucket;
  }
  if (node["@graph"]) collectJobPostings(node["@graph"], bucket);
  const type = node["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) bucket.push(node);
  return bucket;
}

function parseJobPostingsFromHtml(html, sourceUrl) {
  const jobs = [];
  const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      collectJobPostings(parsed, jobs);
    } catch {
      /* skip malformed JSON-LD blocks */
    }
  }
  return jobs.slice(0, 10).map((job, index) => {
    const description = stripHtml(job.description || "");
    const title = stripHtml(job.title || "");
    const company = stripHtml(job.hiringOrganization?.name || job.hiringOrganization || "Unknown company");
    const location = formatLocation(job.jobLocation);
    const text = `${title} ${description}`;
    return {
      id: `live-${Date.now()}-${index}`,
      title,
      company,
      logo: (company[0] || "J").toUpperCase(),
      brand: ["#4ff0e0", "#7c5cff"],
      location,
      mode: /remote/i.test(location) ? "Remote" : "On-site",
      remote: /remote/i.test(location),
      type: stripHtml(job.employmentType || "Full-time").replace(/_/g, " "),
      experience: "Not specified",
      salary: stripHtml(job.baseSalary?.value?.value || job.baseSalary?.value || "Not disclosed"),
      postedHours: 1,
      source: new URL(sourceUrl).hostname.replace(/^www\./, ""),
      category: "Imported",
      team: "Imported from job page",
      skills: Array.from(new Set(text.match(/\b(SQL|Python|Product Strategy|Roadmapping|A\/B Testing|Analytics|Fintech|APIs|LLM|Growth|Figma|Jira|Tableau|Looker|Salesforce)\b/gi) || [])).slice(0, 8),
      description: description.slice(0, 4000),
      url: stripHtml(job.url || sourceUrl),
      importedAt: new Date().toISOString(),
    };
  }).filter((job) => job.title && job.description);
}

async function scrapeUrl(url) {
  const { stdout } = await runObscura(["fetch", url, "--dump", "html", "--timeout", "30", "--quiet"], 45_000);
  return stdout;
}

/**
 * Prefer Obscura, but keep the bridge usable without it for a single posting.
 * The fallback is a plain HTTP fetch for pages that ship JSON-LD server-side.
 */
async function fetchPageHtml(url) {
  try {
    const html = await scrapeUrl(url);
    return { html, engine: "obscura" };
  } catch (error) {
    if (!/ENOENT|not found on PATH/i.test(error.message || "")) throw error;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; AutoMatchBridge/1.0; +https://github.com/h4ckf0r0day/obscura)",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-IN,en;q=0.9",
        },
      });
      if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);
      return { html: await response.text(), engine: "http" };
    } catch (fetchError) {
      if (fetchError.name === "AbortError") throw new Error("The page took too long to respond.");
      throw fetchError;
    } finally {
      clearTimeout(timer);
    }
  }
}


const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  try {
    if (pathname === "/api/health") {
      const health = await obscuraHealth(requestUrl.searchParams.get("force") === "1");
      return json(res, 200, {
        ok: true,
        service: "automatch-bridge",
        obscura: health.obscura,
        version: health.version,
        detail: health.error,
        now: new Date().toISOString(),
      });
    }

    if (pathname === "/api/scrape" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const target = safePublicUrl(body.url);
      const html = await scrapeUrl(target);
      return json(res, 200, { ok: true, url: target, bytes: Buffer.byteLength(html), html });
    }

    if (pathname === "/api/job-from-url" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const target = safePublicUrl(body.url);
      const { html, engine } = await fetchPageHtml(target);
      const jobs = parseJobPostingsFromHtml(html, target);
      return json(res, jobs.length ? 200 : 422, {
        ok: jobs.length > 0,
        url: target,
        engine,
        jobs,
        message: jobs.length
          ? `Extracted ${jobs.length} JobPosting record${jobs.length === 1 ? "" : "s"}.`
          : "The page loaded, but no schema.org JobPosting blocks were found. Add the role manually.",
      });
    }

    if (pathname.startsWith("/api/")) {
      return json(res, 404, { ok: false, error: "Unknown API route." });
    }

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(ROOT, relative);
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, "index.html")) {
      return json(res, 403, { ok: false, error: "Forbidden." });
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(`[bridge] ${req.method} ${pathname}:`, error.message);
    json(res, 500, { ok: false, error: error.message || "Bridge request failed." });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    const health = await obscuraHealth(true);
    console.log(`\nAutoMatch AI running at http://${HOST}:${PORT}`);
    console.log(health.obscura ? `Obscura bridge online · ${health.version}` : `Obscura not detected: ${health.error}`);
    console.log("Job import falls back to plain HTTP fetching without Obscura.\n");
  });
}

module.exports = { parseJobPostingsFromHtml, safePublicUrl, stripHtml, fetchPageHtml };
