# AutoMatch AI — Job Accelerator

A personal workspace for job discovery, AI-powered resume tailoring, and application tracking.

## 🌟 Key Features

- **Job Feed**: Imported job postings with instant match scoring against your master resume.
- **AI Resume Tailoring**: Contextual rewrite of your professional summary and bullet prioritisation without fabrication.
- **Kanban Board**: Drag-and-drop application tracking with notes, attachments, and status history.
- **Resume Hub**: Import PDF/DOCX resumes, edit your source of truth, and export tailored versions as PDF or Word.
- **URL Import (Bridge)**: Pull job details directly from a URL through the local bridge.

## 🎨 Theme: Luxury Black & Gold

The application uses a **Premium Black & Gold** palette inspired by the `ui-ux-pro-max` design system.
- **Primary**: Champagne Gold (#E8C77A)
- **Background**: Deep Warm Black (#080706)
- **Glassmorphism**: High-blur surfaces with gold hairlines and tactile depth.

## 🛠️ Usage

### 1. First run
1. Open the app and go to **Settings**.
2. Upload your resume (PDF, DOCX, TXT, MD or JSON) or fill it in with **Edit**.
3. Under **AI engine**, set the FreeLLMAPI base URL, paste your unified key (`freellmapi-...`) and click **Save engine**.

### 2. Local server and job import
Requires Node.js.
```bash
node server.js
```
The app runs at `http://127.0.0.1:4173`. Importing a job by URL needs this local server; it does not run on Vercel.
- Optional: install the [Obscura CLI](https://github.com/h4ckf0r0day/obscura) on your PATH for JavaScript-heavy job pages. Without it, the server falls back to plain HTTP fetching.

### 3. AI providers
Choose a provider in **Settings > AI engine**:
- **FreeLLMAPI** (default): your [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) gateway (OpenAI-compatible).
- **OpenAI**: e.g. `gpt-4o-mini`, `gpt-4o`.
- **Anthropic**: e.g. `claude-3-5-sonnet-latest`.

Keys are stored in your browser's `localStorage` and sent only to the provider you choose. If a request fails, an on-device fallback reorders and trims your existing bullets so tailoring still produces a result.

**FreeLLMAPI setup**
- Set the base URL to your gateway's address including `/v1` (for a local gateway: `http://localhost:3001/v1`).
- Use the **Unified API key** from the gateway's Keys page. Model `auto` lets its router pick; `auto:smart` favours stronger models.
- The gateway blocks browser calls from unknown origins. Add the app's origins to `DASHBOARD_ORIGINS` in the gateway's environment and restart it, e.g. `DASHBOARD_ORIGINS=http://127.0.0.1:4173,https://jobfinder-nine-beta.vercel.app`.

## 📐 Implementation Details

- **Single Page Application**: Pure JS/HTML/CSS with `localStorage` persistence.
- **No-fabrication guard**: AI output is rejected if it introduces numbers that are not in your resume; skills must already appear in it.
- **PDF/DOCX Processing**: Uses `pdf.js` for coordinate-based text reconstruction and `Mammoth` for Word extraction.
- **Privacy**: Resume and application data stay in your browser except for the text sent to your chosen AI provider when you tailor.
