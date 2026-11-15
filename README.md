# AutoMatch AI — Job Accelerator Prototype

A calm, high-performance workspace for job discovery, AI-powered resume tailoring, and application tracking. Built as a local-first prototype with a focus on UX and efficiency.

## 🌟 Key Features

- **Discovery Feed**: Curated job listings with instant match scoring based on your master resume.
- **AI Resume Tailoring**: Contextual rewrite of your professional summary and bullet prioritisation without fabrication.
- **Kanban Board**: Drag-and-drop application tracking with notes, attachments, and status history.
- **Resume Hub**: Import PDF/DOCX resumes, edit your source of truth, and export tailored versions as PDF or Word.
- **URL Import (Bridge)**: Pull job details directly from a URL using the Obscura bridge.

## 🎨 Theme: Luxury Black & Gold

The application uses a **Premium Black & Gold** palette inspired by the `ui-ux-pro-max` design system.
- **Primary**: Champagne Gold (#E8C77A)
- **Background**: Deep Warm Black (#080706)
- **Glassmorphism**: High-blur surfaces with gold hairlines and tactile depth.

## 🛠️ Local Usage

### 1. Start the Server
Requires Node.js installed.
```bash
node server.js
```
The application will be available at `http://127.0.0.1:4173`.

### 2. (Optional) Obscura Bridge
To use the "Import from URL" feature, download the **Obscura CLI** and ensure it is in your system PATH.
- **Repo**: [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)
- The server automatically detects Obscura on startup and enables advanced scraping.

### 3. AI Providers
By default, AutoMatch uses a **deterministic demo engine** that runs entirely in the browser (zero-cost, instant). For higher-quality LLM rewrites:
- Go to **Settings > AI Engine**.
- Select a provider from the dropdown, enter your API key, and choose a model.
- Available providers:
  - **Demo engine**: On-device simulation (no key required)
  - **OpenAI**: e.g., `gpt-4o-mini`, `gpt-4o`
  - **Anthropic**: e.g., `claude-3-5-sonnet-latest`, `claude-3-opus-latest`
  - **FreeLLMAPI**: your self-hosted [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) gateway (OpenAI-compatible)
- Keys are stored locally in your browser's `localStorage` and never sent to our servers.

**FreeLLMAPI setup**
- FreeLLMAPI is self-hosted. The default base URL is `http://localhost:3001/v1`; change it in Settings if you host the gateway elsewhere.
- Use the **Unified API key** (`freellmapi-...`) from the gateway's Keys page. Model `auto` lets its router pick; `auto:smart` favours stronger models.
- The gateway blocks browser calls from unknown origins. Add the app's origin to `DASHBOARD_ORIGINS` in the gateway's `.env` and restart it, e.g. `DASHBOARD_ORIGINS=http://127.0.0.1:4173,https://your-app.vercel.app`.
- A Vercel-hosted copy calling `http://localhost:3001` only works on the machine running the gateway. To use it from other devices, host the gateway behind HTTPS.

## 📐 Implementation Details

- **Single Page Application**: Pure JS/HTML/CSS with `localStorage` persistence.
- **Demo Engine**: Re-prioritises experience bullets based on keyword overlap and extracts numeric proof-points to ensure factual integrity.
- **PDF/DOCX Processing**: Uses `pdf.js` for coordinate-based text reconstruction and `Mammoth` for Word extraction.
- **Privacy**: No user data, resumes, or keys leave your machine except to your chosen AI provider.

---
*Created as an AutoMatch AI prototype.*
